// api/sync/bol.js — Definitieve versie
// Open orders via /orders endpoint
// Historische orders via /shipments endpoint (direct verwerken zonder extra detail call)

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

  // ── MODE: orders ─────────────────────────────────────────
  if (mode === 'orders') {
    const r = await fetch(`${BASE}/orders?fulfilment-method=ALL&status=ALL&page=${currentPage}`, { headers });
    if (!r.ok) {
      const err = await r.text();
      return res.status(r.status).json({ error: `Orders API fout (${r.status})`, detail: err.substring(0, 300) });
    }
    const data      = await r.json();
    const summaries = data.orders || [];
    const ordersNew = await processOrderSummaries(summaries, storeId, user.id, headers, supabase);
    const hasMore   = summaries.length >= 50;

    return res.status(200).json({
      ordersNew, hasMore, nextPage: hasMore ? currentPage + 1 : null,
      message: `Orders pagina ${currentPage}: ${ordersNew} verwerkt.`, mode: 'orders'
    });
  }

  // ── MODE: shipments ───────────────────────────────────────
  if (mode === 'shipments') {
    const r = await fetch(`${BASE}/shipments?page=${currentPage}`, { headers });
    if (!r.ok) {
      const err = await r.text();
      return res.status(r.status).json({ error: `Shipments API fout (${r.status})`, detail: err.substring(0, 300) });
    }
    const data      = await r.json();
    const shipments = data.shipments || [];

    // Debug: stuur ook de ruwe data mee zodat we kunnen zien wat bol teruggeeft
    const sample = shipments.slice(0, 2);

    let ordersNew = 0;

    // Groepeer per orderId
    const orderMap = {};
    for (const s of shipments) {
      const orderId = s.orderId || s.order?.orderId;
      if (!orderId) continue;
      if (!orderMap[orderId]) {
        orderMap[orderId] = {
          orderId,
          shipmentDate: s.shipmentDate || s.shipmentItems?.[0]?.shipmentDate,
          items: []
        };
      }
      const items = s.shipmentItems || s.items || [];
      for (const item of items) {
        orderMap[orderId].items.push(item);
      }
    }

    const orderIds = Object.keys(orderMap);

    // Probeer order details op te halen, anders gebruik shipment data direct
    const BATCH = 5;
    for (let i = 0; i < orderIds.length; i += BATCH) {
      const batch   = orderIds.slice(i, i + BATCH);
      const details = await Promise.all(batch.map(oid => fetchOrderDetail(oid, headers)));

      for (let j = 0; j < batch.length; j++) {
        const orderId  = batch[j];
        const detail   = details[j];
        const shipment = orderMap[orderId];

        if (detail) {
          // Order detail gevonden — verwerk normaal
          if (await upsertOrder(detail, storeId, user.id, supabase, 'shipped')) ordersNew++;
        } else {
          // Geen detail — gebruik shipment data direct
          const shipmentDate = shipment.shipmentDate?.substring(0, 10) || new Date().toISOString().split('T')[0];
          const items        = shipment.items || [];
          const totalAmount  = items.reduce((sum, i) => sum + (i.unitPrice * (i.quantity || 1) || 0), 0);

          const { data: upserted } = await supabase.from('orders').upsert({
            store_id: storeId, user_id: user.id, platform: 'bol',
            external_id: orderId, order_date: shipmentDate,
            status: 'shipped', total_amount: totalAmount, raw_data: shipment
          }, { onConflict: 'store_id,external_id', ignoreDuplicates: false }).select('id').single();

          if (upserted && items.length > 0) {
            const orderItems = items.map(item => ({
              order_id: upserted.id, store_id: storeId, user_id: user.id, platform: 'bol',
              product_title: item.product?.title || item.title || 'Onbekend',
              product_ean:   item.product?.ean   || item.ean || null,
              quantity:      item.quantity       || 1,
              unit_price:    item.unitPrice      || 0,
              total_price:   (item.unitPrice || 0) * (item.quantity || 1)
            }));
            await supabase.from('order_items').delete().eq('order_id', upserted.id);
            await supabase.from('order_items').insert(orderItems);
            ordersNew++;
          }
        }
      }
    }

    const hasMore = shipments.length >= 50;
    return res.status(200).json({
      ordersNew, hasMore, nextPage: hasMore ? currentPage + 1 : null,
      message: `Shipments pagina ${currentPage}: ${ordersNew} verwerkt.`,
      mode: 'shipments', totalShipments: shipments.length, orderIds: orderIds.length,
      sample: sample // debug info
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

async function processOrderSummaries(summaries, storeId, userId, headers, supabase) {
  let count = 0;
  const BATCH = 5;
  for (let i = 0; i < summaries.length; i += BATCH) {
    const details = await Promise.all(
      summaries.slice(i, i + BATCH).map(o => fetchOrderDetail(o.orderId, headers))
    );
    for (const detail of details) {
      if (!detail) continue;
      if (await upsertOrder(detail, storeId, userId, supabase, 'open')) count++;
    }
  }
  return count;
}

async function upsertOrder(detail, storeId, userId, supabase, defaultStatus) {
  const orderDate   = (detail.orderPlacedDateTime || '').substring(0, 10) || new Date().toISOString().split('T')[0];
  const totalAmount = (detail.orderItems || []).reduce((sum, i) => sum + (i.totalPrice || (i.unitPrice * (i.quantity || 1)) || 0), 0);
  const status      = getOrderStatus(detail.orderItems || []) || defaultStatus;

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
