// api/orders.js — bol.com Retailer API v10
// Haalt bestellingen en omzet op via Client Credentials

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
    // Bestellingen ophalen (meerdere pagina's)
    let allOrders = [];
    let page = 1;
    let hasMore = true;

    while (hasMore && page <= 5) { // max 5 pagina's = 500 orders
      const ordersRes = await fetch(
        `${BASE}/orders?fulfilment-method=ALL&status=ALL&page=${page}`,
        { headers }
      );

      if (!ordersRes.ok) {
        const err = await ordersRes.text();
        return res.status(ordersRes.status).json({
          error: `Bestellingen ophalen mislukt (${ordersRes.status})`,
          detail: err.substring(0, 200)
        });
      }

      const ordersData = await ordersRes.json();
      const orders = ordersData.orders || [];

      if (orders.length === 0) {
        hasMore = false;
      } else {
        allOrders = allOrders.concat(orders);
        page++;
        if (orders.length < 100) hasMore = false;
      }
    }

    // Filter op datum
    const startTs = new Date(start).getTime();
    const endTs = new Date(end).getTime() + 86400000;

    const filtered = allOrders.filter(order => {
      const orderDate = new Date(order.orderPlacedDateTime || order.orderDate || 0).getTime();
      return orderDate >= startTs && orderDate <= endTs;
    });

    // Statistieken berekenen
    let totalOmzet = 0;
    let totalBestellingen = filtered.length;
    let productMap = {};
    let dagMap = {};

    filtered.forEach(order => {
      const items = order.orderItems || [];
      const dag = (order.orderPlacedDateTime || '').substring(0, 10);

      items.forEach(item => {
        const prijs = item.unitPrice || item.offerPrice || 0;
        const qty = item.quantity || 1;
        const omzet = prijs * qty;
        totalOmzet += omzet;

        // Per product
        const title = item.product?.title || item.title || 'Onbekend product';
        const ean = item.product?.ean || item.ean || 'unknown';
        if (!productMap[ean]) {
          productMap[ean] = { titel: title, ean, stuks: 0, omzet: 0 };
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

    // Top producten sorteren
    const topProducten = Object.values(productMap)
      .sort((a, b) => b.omzet - a.omzet)
      .slice(0, 10);

    // Dagen sorteren
    const perDag = Object.values(dagMap)
      .sort((a, b) => a.datum.localeCompare(b.datum));

    // Gemiddelde orderwaarde
    const gemOmzet = totalBestellingen > 0 ? totalOmzet / totalBestellingen : 0;

    return res.status(200).json({
      samenvatting: {
        totalBestellingen,
        totalOmzet: Math.round(totalOmzet * 100) / 100,
        gemOmzetPerBestelling: Math.round(gemOmzet * 100) / 100,
        periode: { start, end }
      },
      topProducten,
      perDag,
      opgehaaldOp: new Date().toISOString()
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
