// api/orders.js — bol.com Retailer API v10
// Configuratie: maximale uitvoeringstijd Vercel = 10s
// Strategie: lijst ophalen met datum, dan parallel details voor gefilterde orders

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(200).end();
  }
  res.setHeader('Access-Control-Allow-Origin', '*');

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Geen geldig Bearer token meegegeven' });
  }

  const token = authHeader.split(' ')[1];
  const { startDate, endDate } = req.query;
  const end   = endDate   || new Date().toISOString().split('T')[0];
  const start = startDate || new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];

  const BASE = 'https://api.bol.com/retailer';
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.retailer.v10+json'
  };

  const startTs = new Date(start).getTime();
  const endTs   = new Date(end).getTime() + 86400000;

  try {
    // Stap 1: haal orderlijst op — bevat orderId + orderPlacedDateTime
    // Gebruik status=ALL en meerdere pagina's
    let candidateIds = [];
    let page = 1;
    let keepGoing = true;

    while (keepGoing && page <= 15) {
      const r = await fetch(
        `${BASE}/orders?fulfilment-method=ALL&status=ALL&page=${page}`,
        { headers }
      );
      if (!r.ok) {
        const err = await r.text();
        return res.status(r.status).json({ error: `Orders lijst mislukt (${r.status})`, detail: err.substring(0,200) });
      }

      const data = await r.json();
      const orders = data.orders || [];
      if (orders.length === 0) break;

      let foundOlderThanStart = false;
      for (const o of orders) {
        const dt = o.orderPlacedDateTime || o.orderDate || '';
        if (!dt) {
          // Geen datum in lijst — voeg altijd toe en haal detail op
          candidateIds.push(o.orderId);
          continue;
        }
        const ts = new Date(dt).getTime();
        if (ts > endTs) continue; // te nieuw, skip
        if (ts < startTs) {
          foundOlderThanStart = true;
          break; // ouder dan periode, stop met pagineren
        }
        candidateIds.push(o.orderId);
      }

      if (foundOlderThanStart) break;
      page++;
      if (orders.length < 50) break;
    }

    if (candidateIds.length === 0) {
      return res.status(200).json({
        samenvatting: { totalBestellingen: 0, totalOmzet: 0, gemOmzetPerBestelling: 0, periode: { start, end } },
        topProducten: [], perDag: [],
        opgehaaldOp: new Date().toISOString()
      });
    }

    // Stap 2: haal details parallel op (max 20 tegelijk)
    const allOrders = [];
    const batchSize = 20;

    for (let i = 0; i < candidateIds.length; i += batchSize) {
      const batch = candidateIds.slice(i, i + batchSize);
      const details = await Promise.all(
        batch.map(async id => {
          try {
            const r = await fetch(`${BASE}/orders/${id}`, { headers });
            if (!r.ok) return null;
            return await r.json();
          } catch { return null; }
        })
      );
      details.forEach(o => {
        if (!o) return;
        const dt = o.orderPlacedDateTime || '';
        const ts = dt ? new Date(dt).getTime() : 0;
        if (!dt || (ts >= startTs && ts <= endTs)) allOrders.push(o);
      });
    }

    // Stap 3: statistieken
    let totalOmzet = 0;
    const productMap = {};
    const dagMap = {};

    allOrders.forEach(order => {
      const dag = (order.orderPlacedDateTime || '').substring(0, 10);
      (order.orderItems || []).forEach(item => {
        const unitPrice  = item.unitPrice  || 0;
        const totalPrice = item.totalPrice  || 0;
        const qty        = item.quantity    || 1;
        const omzet      = totalPrice || (unitPrice * qty);
        totalOmzet += omzet;

        const titel = item.product?.title || item.offer?.reference || `EAN: ${item.product?.ean || '?'}`;
        const ean   = item.product?.ean   || item.offer?.offerId   || ('r' + Math.random());

        if (!productMap[ean]) productMap[ean] = { titel, ean, stuks: 0, omzet: 0 };
        productMap[ean].stuks += qty;
        productMap[ean].omzet += omzet;

        if (dag) {
          if (!dagMap[dag]) dagMap[dag] = { datum: dag, bestellingen: 0, omzet: 0 };
          dagMap[dag].bestellingen++;
          dagMap[dag].omzet += omzet;
        }
      });
    });

    const totalBestellingen = allOrders.length;
    const gemOmzet = totalBestellingen > 0 ? totalOmzet / totalBestellingen : 0;

    return res.status(200).json({
      samenvatting: {
        totalBestellingen,
        totalOmzet: Math.round(totalOmzet * 100) / 100,
        gemOmzetPerBestelling: Math.round(gemOmzet * 100) / 100,
        periode: { start, end }
      },
      topProducten: Object.values(productMap).sort((a,b) => b.omzet - a.omzet).slice(0, 10),
      perDag: Object.values(dagMap).sort((a,b) => a.datum.localeCompare(b.datum)),
      opgehaaldOp: new Date().toISOString()
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
