// api/orders.js — bol.com Retailer API v10

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

  try {
    // Stap 1: lijst van bestellingen ophalen
    let allOrders = [];
    let page = 1;
    let hasMore = true;

    while (hasMore && page <= 10) {
      const ordersRes = await fetch(
        `${BASE}/orders?fulfilment-method=ALL&status=ALL&page=${page}`,
        { headers }
      );

      if (!ordersRes.ok) {
        const err = await ordersRes.text();
        return res.status(ordersRes.status).json({
          error: `Bestellingen ophalen mislukt (${ordersRes.status})`,
          detail: err.substring(0, 300)
        });
      }

      const ordersData = await ordersRes.json();
      const orders = ordersData.orders || [];
      if (orders.length === 0) { hasMore = false; break; }
      allOrders = allOrders.concat(orders);
      page++;
      if (orders.length < 50) hasMore = false;
    }

    // Stap 2: filter op datum via orderPlacedDateTime
    const startTs = new Date(start).getTime();
    const endTs   = new Date(end).getTime() + 86400000;

    const filtered = allOrders.filter(order => {
      const dt = order.orderPlacedDateTime || '';
      if (!dt) return false;
      const ts = new Date(dt).getTime();
      return ts >= startTs && ts <= endTs;
    });

    // Stap 3: voor elke bestelling de details ophalen (bevat prijs en productnaam)
    const detailed = await Promise.all(
      filtered.slice(0, 100).map(async order => {
        const orderId = order.orderId;
        try {
          const detailRes = await fetch(`${BASE}/orders/${orderId}`, { headers });
          if (!detailRes.ok) return order;
          return await detailRes.json();
        } catch { return order; }
      })
    );

    // Stap 4: statistieken berekenen uit detail responses
    let totalOmzet = 0;
    let productMap = {};
    let dagMap = {};

    detailed.forEach(order => {
      const dag = (order.orderPlacedDateTime || '').substring(0, 10);
      const items = order.orderItems || [];

      items.forEach(item => {
        // Prijsvelden proberen
        const unitPrice  = item.unitPrice  || 0;
        const offerPrice = item.offerPrice  || 0;
        const prijs = unitPrice || offerPrice || 0;
        const qty   = item.quantity || item.quantityOrdered || 1;
        const omzet = prijs * qty;
        totalOmzet += omzet;

        // Productnaam — zit in item.product of direct op item
        const titel =
          item.product?.title ||
          item.product?.attributes?.find(a => a.attributeId === 'Title')?.value ||
          item.title ||
          item.productTitle ||
          item.offerReference ||
          `EAN: ${item.product?.ean || item.ean || '?'}`;

        const ean = item.product?.ean || item.ean || String(Math.random());

        if (!productMap[ean]) {
          productMap[ean] = { titel, ean, stuks: 0, omzet: 0 };
        }
        productMap[ean].stuks += qty;
        productMap[ean].omzet += omzet;

        // Per dag
        if (dag) {
          if (!dagMap[dag]) dagMap[dag] = { datum: dag, bestellingen: 0, omzet: 0 };
          dagMap[dag].bestellingen += 1;
          dagMap[dag].omzet += omzet;
        }
      });
    });

    const totalBestellingen = filtered.length;
    const gemOmzet = totalBestellingen > 0 ? totalOmzet / totalBestellingen : 0;

    const topProducten = Object.values(productMap)
      .sort((a, b) => b.omzet - a.omzet)
      .slice(0, 10);

    const perDag = Object.values(dagMap)
      .sort((a, b) => a.datum.localeCompare(b.datum));

    // Debug: stuur ook een sample order mee zodat we de structuur zien
    const sampleItem = detailed[0]?.orderItems?.[0] || null;

    return res.status(200).json({
      samenvatting: {
        totalBestellingen,
        totalOmzet: Math.round(totalOmzet * 100) / 100,
        gemOmzetPerBestelling: Math.round(gemOmzet * 100) / 100,
        periode: { start, end }
      },
      topProducten,
      perDag,
      debug: { sampleItem },
      opgehaaldOp: new Date().toISOString()
    });

  } catch (err) {
    return res.status(500).json({ error: err.message, stack: err.stack?.substring(0, 300) });
  }
}
