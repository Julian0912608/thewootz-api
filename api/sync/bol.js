// api/sync/bol.js — Timeout-proof versie
// Open orders: via /orders + detail calls (klein aantal)
// Historische orders: via /shipments ZONDER extra detail calls (direct opslaan)

import { setCors, getSupabase, getUser } from '../_lib/supabase.js';

const BASE = 'https://api.bol.com/retailer';

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: 'Niet ingelogd' });

  const { storeId, mode = 'orders', page = 1 } = req.body || {};
  if (!storeId) return res.status(400).json({ error: 'storeId verplicht' });

  const supabase = getSupabase();
  const { data: store } = await supabase
    .from('stores').select('*').eq('id', storeId).eq('user_id', user.id).single();

  if (!store) return res.status(404).json({ error: 'Store niet gevonden' });

  const clientId     = Buffer.from(store.client_id_enc,     'base64').toString('utf8');
  const clientSecret = Buffer.from(store.client_secret_enc, 'base64').toString('utf8');
  const token        = await getBolToken(clientId, clientSecret);
  if (!token) return res.status(401).json({ error: 'Bol.com authenticatie mislukt' });

  const headers = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.retailer.v10+json'
  };

  const currentPage = parseInt(page) || 1;

  // ── MODE: orders — open bestellingen met detail calls ─────
  if (mode === 'orders') {
    const r = await fetch(`${BASE}/orders?fulfilment-method=ALL&status=ALL&page=${currentPage}`, { headers });
    if (!r.ok) {
      const err = await r.text();
      return res.status(r.status).json({ error: `Orders API fout (${r.status})`, detail: err.substring(0, 300) });
    }
    const data      = await r.json();
    const summaries = data.orders || [];
    let ordersNew   = 0;

    // Detail calls in batches van 5
    for (let i = 0; i < summaries.length; i += 5) {
      const batch   = summaries.slice(i, i + 5);
      const details = await Promise.all(batch.map(o => fetchOrderDetail(o.orderId, headers)));
      for (const detail of details) {
        if (detail && await upsertOrder(detail, storeId, user.id, supabase)) ordersNew++;
      }
    }

    const hasMore = summaries.length >= 50;
    return res.status(200).json({
      ordersNew, hasMore, nextPage: hasMore ? currentPage + 1 : null,
      message: `Orders p${currentPage}: ${ordersNew} verwerkt.`, mode: 'orders'
    });
  }

  // ── MODE: shipments — historische orders via shipments endpoint ──
  // Bol.com /orders geeft alleen laatste 48u. Shipments gaan jaren terug.
  // We gebruiken hier orderPlacedDateTime (zit in shipment object) voor de juiste order_date.
  if (mode === 'shipments') {
    const r = await fetch(`${BASE}/shipments?page=${currentPage}`, { headers });
    if (!r.ok) {
      const err = await r.text();
      return res.status(r.status).json({ error: `Shipments API fout (${r.status})`, detail: err.substring(0, 300) });
    }
    const data      = await r.json();
    const shipments = data.shipments || [];
    let ordersNew   = 0;

    // Groepeer shipment items per orderId
    // Bol.com shipment structuur: { shipmentId, orderId, shipmentDate, order: { orderPlacedDateTime }, shipmentItems: [...] }
    const orderMap = {};
    for (const s of shipments) {
      const orderId = s.orderId;
      if (!orderId) continue;

      if (!orderMap[orderId]) {
        // Prioriteit voor orderPlacedDateTime (echte besteldatum), anders shipmentDate
        const orderDate =
          s.order?.orderPlacedDateTime?.substring(0, 10) ||
          s.orderPlacedDateTime?.substring(0, 10) ||
          s.shipmentDate?.substring(0, 10) ||
          new Date().toISOString().split('T')[0];

        orderMap[orderId] = { orderId, orderDate, items: [] };
      }

      const items = s.shipmentItems || [];
      for (const item of items) {
        orderMap[orderId].items.push({
          product_title: item.product?.title || item.title || 'Onbekend product',
          product_ean:   item.product?.ean   || item.ean  || null,
          quantity:      item.quantity       || 1,
          unit_price:    item.unitPrice      || 0,
          total_price:   (item.unitPrice || 0) * (item.quantity || 1)
        });
      }
    }

    // Sla op in Supabase
    // BELANGRIJK: ignoreDuplicates: false + alleen order_date updaten als die nog 'vandaag' is
    // (betekent dat de orders-mode hem net heeft opgeslagen zonder echte datum)
    for (const [orderId, order] of Object.entries(orderMap)) {
      const totalAmount = order.items.reduce((sum, i) => sum + i.total_price, 0);
      const today = new Date().toISOString().split('T')[0];

      // Kijk of order al bestaat
      const { data: existing } = await supabase
        .from('orders')
        .select('id, order_date')
        .eq('store_id', storeId)
        .eq('external_id', orderId)
        .single();

      let dbOrderId;

      if (existing) {
        // Order bestaat al — update order_date als die vandaag is (= placeholder uit orders-mode)
        // of als we een betere datum hebben
        const shouldUpdateDate = existing.order_date >= today || existing.order_date === today;
        if (shouldUpdateDate && order.orderDate < today) {
          await supabase.from('orders')
            .update({ order_date: order.orderDate, status: 'shipped', total_amount: totalAmount })
            .eq('id', existing.id);
        }
        dbOrderId = existing.id;
      } else {
        // Nieuwe order aanmaken
        const { data: inserted } = await supabase.from('orders').insert({
          store_id:     storeId,
          user_id:      user.id,
          platform:     'bol',
          external_id:  orderId,
          order_date:   order.orderDate,
          status:       'shipped',
          total_amount: totalAmount,
          raw_data:     { orderId, orderDate: order.orderDate }
        }).select('id').single();

        if (!inserted) continue;
        dbOrderId = inserted.id;
        ordersNew++;
      }

      // Order items opslaan/verversen
      if (order.items.length > 0) {
        const dbItems = order.items.map(item => ({
          ...item,
          order_id:  dbOrderId,
          store_id:  storeId,
          user_id:   user.id,
          platform:  'bol'
        }));
        await supabase.from('order_items').delete().eq('order_id', dbOrderId);
        await supabase.from('order_items').insert(dbItems);
      }
    }

    const hasMore = shipments.length >= 50;
    return res.status(200).json({
      ordersNew, hasMore, nextPage: hasMore ? currentPage + 1 : null,
      message: `Shipments p${currentPage}: ${ordersNew} nieuwe + bestaande bijgewerkt uit ${shipments.length} shipments.`,
      mode: 'shipments'
    });
  }

  // ── MODE: finalize ────────────────────────────────────────
  if (mode === 'finalize') {
    await supabase.from('stores').update({ last_synced_at: new Date().toISOString() }).eq('id', storeId);
    await supabase.from('sync_log').insert({ store_id: storeId, user_id: user.id, status: 'ok' });
    return res.status(200).json({ message: 'Sync afgerond.' });
  }

  return res.status(400).json({ error: 'Onbekende mode' });
}

async function upsertOrder(detail, storeId, userId, supabase) {
  const orderDate   = (detail.orderPlacedDateTime || '').substring(0, 10) || new Date().toISOString().split('T')[0];
  const totalAmount = (detail.orderItems || []).reduce((sum, i) => sum + (i.totalPrice || (i.unitPrice * (i.quantity || 1)) || 0), 0);
  const status      = getOrderStatus(detail.orderItems || []);

  const { data: upserted } = await supabase.from('orders').upsert({
    store_id: storeId, user_id: userId, platform: 'bol',
    external_id: detail.orderId, order_date: orderDate,
    status, total_amount: totalAmount, raw_data: detail
  }, { onConflict: 'store_id,external_id', ignoreDuplicates: false }).select('id').single();

  if (!upserted) return false;

  const items = (detail.orderItems || []).map(item => ({
    order_id: upserted.id, store_id: storeId, user_id: userId, platform: 'bol',
    product_title: item.product?.title || item.offer?.reference || 'Onbekend',
    product_ean:   item.product?.ean   || null,
    quantity:      item.quantity       || 1,
    unit_price:    item.unitPrice      || 0,
    total_price:   item.totalPrice     || (item.unitPrice * (item.quantity || 1)) || 0
  }));

  await supabase.from('order_items').delete().eq('order_id', upserted.id);
  if (items.length > 0) await supabase.from('order_items').insert(items);
  return true;
}

async function getBolToken(clientId, clientSecret) {
  try {
    const creds = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const r = await fetch('https://login.bol.com/token?grant_type=client_credentials', {
      method: 'POST',
      headers: { 'Authorization': `Basic ${creds}`, 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    if (!r.ok) return null;
    return (await r.json()).access_token;
  } catch { return null; }
}

async function fetchOrderDetail(orderId, headers) {
  try {
    const r = await fetch(`${BASE}/orders/${orderId}`, { headers });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

function getOrderStatus(items) {
  if (!items?.length) return 'shipped';
  if (items.some(i => i.cancellationRequest)) return 'cancelled';
  if (items.every(i => i.shipmentDetails?.shipmentDate)) return 'shipped';
  return 'open';
}
