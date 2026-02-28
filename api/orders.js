// api/orders.js — bol.com Retailer API v10
// Shipments endpoint = historische data tot ver terug
// Shipment-lijst bevat al orderPlacedDateTime en EAN — geen detail calls nodig voor basisdata
// Detail calls alleen voor productnamen van top-EANs

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

  try {
    // === STAP 1: Shipments ophalen (gesorteerd nieuwste eerst) ===
    // Shipment-lijst bevat: shipmentId, shipmentDateTime, order.orderPlacedDateTime, shipmentItems[].ean + unitPrice + quantity
    let allShipmentItems = [];
    const seenOrders = new Set();
    let page = 1;
    let stop = false;

    while (!stop && page <= 20) {
      const r = await fetch(`${BASE}/shipments?fulfilment-method=ALL&page=${page}`, { headers: H });
      if (!r.ok) break;

      const data = await r.json();
      const shipments = data.shipments || [];
      if (shipments.length === 0) break;

      for (const s of shipments) {
        // Gebruik orderPlacedDateTime voor datum, val terug op shipmentDateTime
        const orderDt = s.order?.orderPlacedDateTime || s.shipmentDateTime || '';
        const ts = orderDt ? new Date(orderDt).getTime() : 0;

        // Stop zodra we shipments zien die ouder zijn dan startDate
        if (ts > 0 && ts < startTs) { stop = true; break; }
        // Sla over als buiten periode
        if (ts > endTs) continue;

        const orderId = s.order?.orderId || s.shipmentId;
        if (seenOrders.has(orderId)) continue;
        seenOrders.add(orderId);

        // shipmentItems bevatten ean, unitPrice, quantity
        (s.shipmentItems || []).forEach(item => {
          allShipmentItems.push({
            ean:       item.ean || '',
            qty:       item.quantity || 1,
            unitPrice: item.unitPrice || 0,
            dag:       orderDt.substring(0, 10),
            orderId
          });
        });
      }

      page++;
      if (shipments.length < 50) break;
    }

    // === STAP 2: Open orders ophalen (nog niet verzonden, max 48u oud) ===
    const openR = await fetch(`${BASE}/orders?fulfilment-method=ALL&status=OPEN&page=1`, { headers: H });
    if (openR.ok) {
      const openData = await openR.json();
      for (const o of (openData.orders || [])) {
        const dt  = o.orderPlacedDateTime || '';
        const ts  = dt ? new Date(dt).getTime() : Date.now();
        if (ts < startTs || ts > endTs) continue;
        if (seenOrders.has(o.orderId)) continue;
        seenOrders.add(o.orderId);
        // Open orders in lijst hebben orderItems met ean en quantity maar soms geen prijs
        (o.orderItems || []).forEach(item => {
          allShipmentItems.push({
            ean:       item.ean || '',
            qty:       item.quantity || 1,
            unitPrice: item.unitPrice || 0,
            dag:       dt.substring(0, 10),
            orderId:   o.orderId
          });
        });
      }
    }

    // === STAP 3: Productnamen ophalen via offers endpoint voor unieke EANs ===
    // Gebruik de EAN→titel mapping door shipment details op te halen voor top EANs
    const eanCount = {};
    allShipmentItems.forEach(i => {
      if (i.ean) eanCount[i.ean] = (eanCount[i.ean] || 0) + i.qty;
    });
    const topEANs = Object.entries(eanCount).sort((a,b) => b[1]-a[1]).slice(0,10).map(e => e[0]);

    // Haal productnamen op via 1 shipment detail per EAN (efficiënt)
    const eanToTitle = {};
    if (topEANs.length > 0) {
      // Zoek voor elke top-EAN het eerste shipment op om de naam te krijgen
      const eanToShipmentId = {};
      // We moeten terug naar de ruwe shipments om shipmentIds te koppelen aan EANs
      // Eenvoudiger: haal 1 shipment detail op van page 1 voor de namen
      const detailR = await fetch(`${BASE}/shipments?fulfilment-method=ALL&page=1`, { headers: H });
      if (detailR.ok) {
        const detailData = await detailR.json();
        for (const s of (detailData.shipments || [])) {
          if (!eanToShipmentId[s.shipmentId]) {
            for (const item of (s.shipmentItems || [])) {
              if (topEANs.includes(item.ean) && !eanToShipmentId[item.ean]) {
                eanToShipmentId[item.ean] = s.shipmentId;
              }
            }
          }
        }
      }

      // Haal shipment details op voor unieke shipment IDs
      const uniqueShipmentIds = [...new Set(Object.values(eanToShipmentId))].slice(0, 5);
      await Promise.all(uniqueShipmentIds.map(async sid => {
        try {
          const r = await fetch(`${BASE}/shipments/${sid}`, { headers: H });
          if (!r.ok) return;
          const d = await r.json();
          (d.shipmentItems || []).forEach(item => {
            if (item.ean && item.product?.title) {
              eanToTitle[item.ean] = item.product.title;
            }
          });
        } catch {}
      }));
    }

    // === STAP 4: Statistieken berekenen ===
    let totalOmzet = 0;
    const productMap = {};
    const dagMap = {};
    const orderSet = new Set();

    allShipmentItems.forEach(item => {
      const omzet = item.unitPrice * item.qty;
      totalOmzet += omzet;
      orderSet.add(item.orderId);

      const titel = eanToTitle[item.ean] || (item.ean ? `EAN: ${item.ean}` : 'Onbekend product');
      const key = item.ean || titel;

      if (!productMap[key]) productMap[key] = { titel, ean: item.ean, stuks: 0, omzet: 0 };
      productMap[key].stuks += item.qty;
      productMap[key].omzet += omzet;

      if (item.dag) {
        if (!dagMap[item.dag]) dagMap[item.dag] = { datum: item.dag, bestellingen: 0, omzet: 0 };
        dagMap[item.dag].bestellingen++;
        dagMap[item.dag].omzet += omzet;
      }
    });

    const totalBestellingen = orderSet.size;
    const gemOmzet = totalBestellingen > 0 ? totalOmzet / totalBestellingen : 0;

    return res.status(200).json({
      samenvatting: {
        totalBestellingen,
        totalOmzet:            Math.round(totalOmzet * 100) / 100,
        gemOmzetPerBestelling: Math.round(gemOmzet  * 100) / 100,
        periode: { start, end }
      },
      topProducten: Object.values(productMap).sort((a,b) => b.omzet - a.omzet).slice(0, 10),
      perDag:       Object.values(dagMap).sort((a,b) => a.datum.localeCompare(b.datum)),
      opgehaaldOp:  new Date().toISOString()
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
