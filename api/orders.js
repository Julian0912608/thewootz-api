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

  const startTs = new Date(start).getTime();
  const endTs   = new Date(end).getTime() + 86400000;

  try {
    // Stap 1: haal ALLE order-IDs op (alle pagina's, alle statussen)
    let allOrderIds = [];
    
    // Haal per status op zodat we niks missen
    const statuses = ['OPEN', 'SHIPPED', 'ALL'];
    
    for (const status of statuses) {
      let page = 1;
      while (page <= 20) {
        const ordersRes = await fetch(
          `${BASE}/orders?fulfilment-method=ALL&status=${status}&page=${page}`,
          { headers }
        );
        if (!ordersRes.ok) break;
        const data = await ordersRes.json();
        const orders = data.orders || [];
        if (orders.length === 0) break;
        
        orders.forEach(o => {
          if (!allOrderIds.includes(o.orderId)) {
            allOrderIds.push(o.orderId);
          }
        });
        
        page++;
        if (orders.length < 50) break;
      }
    }

    // Stap 2: haal details op per order en filter op datum
    // Doe dit in batches van 10 parallel
    const allOrders = [];
    const batchSize = 10;
    
    for (let i = 0; i < allOrderIds.length; i += batchSize) {
      const batch = allOrderIds.slice(i, i + batchSize);
      const details = await Promise.all(
        batch.map(async orderId => {
          try {
            const r = await fetch(`${BASE}/orders/${orderId}`, { headers });
            if (!r.ok) return null;
            return await r.json();
          } catch { return null; }
        })
      );
      
      details.forEach(order => {
        if (!order) return;
        const dt = order.orderPlacedDateTime || '';
        if (!dt) return;
        const ts = new Date(dt).getTime();
        if (ts >= startTs && ts <= endTs) {
          allOrders.push(order);
        }
      });
    }

    // Stap 3: statistieken berekenen
    let totalOmzet = 0;
    let productMap = {};
    let dagMap = {};

    allOrders.forEach(order => {
      const dag = (order.orderPlacedDateTime || '').substring(0, 10);
      const items = order.orderItems || [];

      items.forEach(item => {
        const unitPrice  = item.unitPrice  || 0;
        const totalPrice = item.totalPrice  || 0;
        const qty        = item.quantity    || 1;
        const omzet      = totalPrice || (unitPrice * qty);
        totalOmzet += omzet;

        const titel =
          item.product?.title ||
          item.offer?.reference ||
          `EAN: ${item.product?.ean || '?'}`;

        const ean = item.product?.ean || item.offer?.offerId || String(Math.random());

        if (!productMap[ean]) {
          productMap[ean] = { titel, ean, stuks: 0, omzet: 0 };
        }
        productMap[ean].stuks += qty;
        productMap[ean].omzet += omzet;

        if (dag) {
          if (!dagMap[dag]) dagMap[dag] = { datum: dag, bestellingen: 0, omzet: 0 };
          dagMap[dag].bestellingen += 1;
          dagMap[dag].omzet += omzet;
        }
      });
    });

    const totalBestellingen = allOrders.length;
    const gemOmzet = totalBestellingen > 0 ? totalOmzet / totalBestellingen : 0;

    const topProducten = Object.values(productMap)
      .sort((a, b) => b.omzet - a.omzet)
      .slice(0, 10);

    const perDag = Object.values(dagMap)
      .sort((a, b) => a.datum.localeCompare(b.datum));

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
