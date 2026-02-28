// api/orders.js — bol.com Retailer API v10
// Gebruikt latest-change-date + status=ALL voor historische data (tot 3 maanden terug)
// Combineert dit met open orders en insights voor volledig dashboard

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(200).end();
  }
  res.setHeader('Access-Control-Allow-Origin', '*');

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Geen geldig Bearer token' });
  }

  const token = authHeader.split(' ')[1];
  const { startDate, endDate } = req.query;
  const end   = endDate   || new Date().toISOString().split('T')[0];
  const start = startDate || new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];

  const BASE = 'https://api.bol.com/retailer';
  const H = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.retailer.v10+json'
  };

  const startTs = new Date(start).getTime();
  const endTs   = new Date(end).getTime() + 86400000;

  // Genereer alle datums tussen start en end
  function getDatesInRange(s, e) {
    const dates = [];
    const cur = new Date(s);
    const last = new Date(e);
    while (cur <= last) {
      dates.push(cur.toISOString().split('T')[0]);
      cur.setDate(cur.getDate() + 1);
    }
    return dates;
  }

  try {
    // === STRATEGIE: latest-change-date per dag ophalen ===
    // Dit geeft ALLE orders (open + shipped + cancelled) voor elke dag
    const dates = getDatesInRange(start, end);
    const allOrderIds = new Set();
    const orderIdToDate = {};

    // Haal per dag de gewijzigde orders op (parallel, max 5 tegelijk)
    async function fetchOrdersForDate(date) {
      const ids = [];
      let page = 1;
      while (page <= 5) {
        const r = await fetch(
          `${BASE}/orders?status=ALL&fulfilment-method=ALL&latest-change-date=${date}&page=${page}`,
          { headers: H }
        );
        if (!r.ok) break;
        const data = await r.json();
        const orders = data.orders || [];
        if (orders.length === 0) break;
        orders.forEach(o => {
          ids.push(o.orderId);
          orderIdToDate[o.orderId] = o.orderPlacedDateTime || date;
        });
        page++;
        if (orders.length < 50) break;
      }
      return ids;
    }

    // Verwerk in batches van 5 dagen parallel
    for (let i = 0; i < dates.length; i += 5) {
      const batch = dates.slice(i, i + 5);
      const results = await Promise.all(batch.map(fetchOrdersForDate));
      results.forEach(ids => ids.forEach(id => allOrderIds.add(id)));
    }

    // Filter op orderPlacedDateTime binnen de periode
    const candidateIds = [...allOrderIds].filter(id => {
      const dt = orderIdToDate[id];
      if (!dt) return true;
      const ts = new Date(dt).getTime();
      return ts >= startTs && ts <= endTs;
    });

    // === Haal order details op (parallel, batches van 10) ===
    const detailedOrders = [];
    for (let i = 0; i < Math.min(candidateIds.length, 100); i += 10) {
      const batch = candidateIds.slice(i, i + 10);
      const details = await Promise.all(
        batch.map(async id => {
          try {
            const r = await fetch(`${BASE}/orders/${id}`, { headers: H });
            if (!r.ok) return null;
            return await r.json();
          } catch { return null; }
        })
      );
      details.forEach(o => {
        if (!o) return;
        const dt = o.orderPlacedDateTime || '';
        const ts = dt ? new Date(dt).getTime() : 0;
        if (!dt || (ts >= startTs && ts <= endTs)) detailedOrders.push(o);
      });
    }

    // === Statistieken ===
    let totalOmzet = 0;
    const productMap = {};
    const dagMap = {};

    detailedOrders.forEach(order => {
      const dag = (order.orderPlacedDateTime || '').substring(0, 10);
      (order.orderItems || []).forEach(item => {
        const unitPrice  = item.unitPrice  || 0;
        const totalPrice = item.totalPrice  || 0;
        const qty        = item.quantity    || 1;
        const omzet      = totalPrice || (unitPrice * qty);
        totalOmzet += omzet;

        const titel = item.product?.title || item.offer?.reference || `EAN: ${item.product?.ean || '?'}`;
        const ean   = item.product?.ean   || item.offer?.offerId   || ('x' + Math.random());

        if (!productMap[ean]) {
          productMap[ean] = { titel, ean, stuks: 0, omzet: 0, orderIds: new Set() };
        }
        productMap[ean].stuks += qty;
        productMap[ean].omzet += omzet;
        productMap[ean].orderIds.add(order.orderId);

        if (dag) {
          if (!dagMap[dag]) dagMap[dag] = { datum: dag, bestellingen: 0, omzet: 0 };
          dagMap[dag].bestellingen++;
          dagMap[dag].omzet += omzet;
        }
      });
    });

    const totalBestellingen = detailedOrders.length;
    const gemOmzet = totalBestellingen > 0 ? totalOmzet / totalBestellingen : 0;

    const topProducten = Object.values(productMap)
      .map(p => ({ ...p, orderIds: p.orderIds.size }))
      .sort((a, b) => b.omzet - a.omzet)
      .slice(0, 10);

    const perDag = Object.values(dagMap)
      .sort((a, b) => a.datum.localeCompare(b.datum));

    return res.status(200).json({
      samenvatting: {
        totalBestellingen,
        totalOmzet:            Math.round(totalOmzet * 100) / 100,
        gemOmzetPerBestelling: Math.round(gemOmzet  * 100) / 100,
        periode: { start, end }
      },
      topProducten,
      perDag,
      opgehaaldOp: new Date().toISOString()
    });

  } catch (err) {
    return res.status(500).json({ error: err.message, stack: err.stack?.substring(0, 200) });
  }
}
