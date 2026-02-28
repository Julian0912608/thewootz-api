// api/orders.js — bol.com Retailer API v10
// Bewezen werkende aanpak: shipments lijst → detail per shipment voor prijs + productnaam

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
  const H = { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.retailer.v10+json' };
  const startTs = new Date(start).getTime();
  const endTs   = new Date(end).getTime() + 86400000;

  try {
    // Stap 1: shipments lijst ophalen — gesorteerd op shipmentDateTime desc
    // Bevat order.orderPlacedDateTime voor datumfiltering
    let shipmentRefs = []; // { shipmentId, orderDate }
    let page = 1;
    let stop = false;

    while (!stop && page <= 15) {
      const r = await fetch(`${BASE}/shipments?fulfilment-method=ALL&page=${page}`, { headers: H });
      if (!r.ok) break;
      const data = await r.json();
      const list = data.shipments || [];
      if (list.length === 0) break;

      for (const s of list) {
        const dt = s.order?.orderPlacedDateTime || s.shipmentDateTime || '';
        const ts = dt ? new Date(dt).getTime() : 0;
        if (ts > 0 && ts < startTs) { stop = true; break; }
        if (ts <= endTs) {
          shipmentRefs.push({ shipmentId: s.shipmentId, orderDate: dt });
        }
      }
      page++;
      if (list.length < 50) break;
    }

    // Stap 2: detail per shipment ophalen (max 30, parallel per 10)
    // Detail bevat: shipmentItems[].product.title, unitPrice, quantity
    const detailedShipments = [];
    for (let i = 0; i < Math.min(shipmentRefs.length, 30); i += 10) {
      const batch = shipmentRefs.slice(i, i + 10);
      const results = await Promise.all(batch.map(async ({ shipmentId, orderDate }) => {
        try {
          const r = await fetch(`${BASE}/shipments/${shipmentId}`, { headers: H });
          if (!r.ok) return null;
          const d = await r.json();
          return { ...d, _orderDate: orderDate };
        } catch { return null; }
      }));
      results.forEach(d => { if (d) detailedShipments.push(d); });
    }

    // Stap 3: open orders toevoegen
    const openR = await fetch(`${BASE}/orders?fulfilment-method=ALL&status=OPEN&page=1`, { headers: H });
    const openOrderDetails = [];
    if (openR.ok) {
      const openData = await openR.json();
      const openList = (openData.orders || []).filter(o => {
        const ts = o.orderPlacedDateTime ? new Date(o.orderPlacedDateTime).getTime() : 0;
        return ts >= startTs && ts <= endTs;
      }).slice(0, 20);

      const openDetails = await Promise.all(openList.map(async o => {
        try {
          const r = await fetch(`${BASE}/orders/${o.orderId}`, { headers: H });
          if (!r.ok) return null;
          return await r.json();
        } catch { return null; }
      }));
      openDetails.forEach(d => { if (d) openOrderDetails.push(d); });
    }

    // Stap 4: statistieken uit shipment details
    let totalOmzet = 0;
    const productMap = {};
    const dagMap = {};
    const seenOrders = new Set();

    // Verwerk shipments
    detailedShipments.forEach(shipment => {
      const orderId = shipment.order?.orderId || shipment.shipmentId;
      if (seenOrders.has(orderId)) return;
      seenOrders.add(orderId);

      const dag = (shipment._orderDate || shipment.order?.orderPlacedDateTime || shipment.shipmentDateTime || '').substring(0, 10);

      (shipment.shipmentItems || []).forEach(item => {
        const unitPrice = item.unitPrice || 0;
        const qty       = item.quantity  || 1;
        const omzet     = unitPrice * qty;
        totalOmzet += omzet;

        const titel = item.product?.title || `EAN: ${item.ean || '?'}`;
        const key   = item.ean || titel;

        if (!productMap[key]) productMap[key] = { titel, ean: item.ean || '', stuks: 0, omzet: 0 };
        productMap[key].stuks += qty;
        productMap[key].omzet += omzet;

        if (dag) {
          if (!dagMap[dag]) dagMap[dag] = { datum: dag, bestellingen: 0, omzet: 0 };
          dagMap[dag].bestellingen++;
          dagMap[dag].omzet += omzet;
        }
      });
    });

    // Verwerk open orders
    openOrderDetails.forEach(order => {
      if (seenOrders.has(order.orderId)) return;
      seenOrders.add(order.orderId);
      const dag = (order.orderPlacedDateTime || '').substring(0, 10);

      (order.orderItems || []).forEach(item => {
        const unitPrice  = item.unitPrice  || 0;
        const totalPrice = item.totalPrice  || 0;
        const qty        = item.quantity    || 1;
        const omzet      = totalPrice || (unitPrice * qty);
        totalOmzet += omzet;

        const titel = item.product?.title || item.offer?.reference || `EAN: ${item.product?.ean || '?'}`;
        const key   = item.product?.ean || item.offer?.offerId || titel;

        if (!productMap[key]) productMap[key] = { titel, ean: item.product?.ean || '', stuks: 0, omzet: 0 };
        productMap[key].stuks += qty;
        productMap[key].omzet += omzet;

        if (dag) {
          if (!dagMap[dag]) dagMap[dag] = { datum: dag, bestellingen: 0, omzet: 0 };
          dagMap[dag].bestellingen++;
          dagMap[dag].omzet += omzet;
        }
      });
    });

    const totalBestellingen = seenOrders.size;
    const gemOmzet = totalBestellingen > 0 ? totalOmzet / totalBestellingen : 0;

    return res.status(200).json({
      samenvatting: {
        totalBestellingen,
        totalOmzet:            Math.round(totalOmzet * 100) / 100,
        gemOmzetPerBestelling: Math.round(gemOmzet   * 100) / 100,
        periode: { start, end }
      },
      topProducten: Object.values(productMap).sort((a, b) => b.omzet - a.omzet).slice(0, 10),
      perDag:       Object.values(dagMap).sort((a, b) => a.datum.localeCompare(b.datum)),
      opgehaaldOp:  new Date().toISOString()
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
