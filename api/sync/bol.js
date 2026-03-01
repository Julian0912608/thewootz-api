// api/sync/bol.js — Bol.com sync (timeout-proof versie)
// Haalt orders op per pagina (max 50), parallel details ophalen in batches van 5

import { setCors, getSupabase, getUser } from '../_lib/supabase.js';

const BASE = 'https://api.bol.com/retailer';

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: 'Niet ingelogd' });

  const { storeId, fullSync, page = 1 } = req.body || {};
  if (!storeId) return res.status(400).json({ error: 'storeId verplicht' });

  const supabase = getSupabase();

  const { data: store, error: storeErr } = await supabase
    .from('stores').select('*').eq('id', storeId).eq('user_id', user.id).single();

  if (storeErr || !store) return res.status(404).json({ error: 'Store niet gevonden' });
  if (store.platform !== 'bol') return res.status(400).json({ error: 'Alleen bol.com stores' });

  const clientId     = Buffer.from(store.client_id_enc,     'base64').toString('utf8');
  const clientSecret = Buffer.from(store.client_secret_enc, 'base64').toString('utf8');

  const token = await getBolToken(clientId, clientSecret);
  if (!token) return res.status(401).json({ error: 'Bol.com authenticatie mislukt — controleer je API credentials' });

  const headers = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.retailer.v10+json'
  };

  const currentPage = parseInt(page) || 1;
  const ordersRes = await fetch(
    `${BASE}/orders?fulfilment-method=ALL&status=ALL&page=${currentPage}`,
    { headers }
  );

  if (!ordersRes.ok) {
    const err = await ordersRes.text();
    return res.status(ordersRes.status).json({
      error: `Bol.com orders ophalen mislukt (${ordersRes.status})`,
      detail: err.substring(0, 300)
    });
  }

  const ordersData = await ordersRes.json();
  const orderSummaries = ordersData.orders || [];

  if (orderSummaries.length === 0) {
    await supabase.from('stores').update({ last_synced_at: new Date().toISOString() }).eq('id', storeId);
    return res.status(200).json({
      message: 'Sync klaar! Geen nieuwe bestellingen gevonden.',
      ordersNew: 0, hasMore: false, nextPage: null
    });
  }

  // Details ophalen in batches van 5 parallel
  let ordersNew = 0;
  const errors = [];
  const BATCH = 5;

  for (let i = 0; i < orderSummaries.length; i += BATCH) {
    const batch = orderSummaries.slice(i, i + BATCH);
    const details = await Promise.all(batch.map(o => fetchOrderDetail(o.orderId, headers)));

    for (const detail of details) {
      if (!detail) continue;

      const orderDate   = (detail.orderPlacedDateTime || '').substring(0, 10) || new Date().toISOString().split('T')[0];
      const totalAmount = calcOrderTotal(detail.orderItems || []);

      const { data: upserted, error: upsertErr } = await supabase
        .from('orders')
        .upsert({
          store_id:     storeId,
          user_id:      user.id,
          platform:     'bol',
          external_id:  detail.orderId,
          order_date:   orderDate,
          status:       getOrderStatus(detail.orderItems || []),
          total_amount: totalAmount,
          raw_data:     detail
        }, { onConflict: 'store_id,external_id', ignoreDuplicates: false })
        .select('id').single();

      if (upsertErr || !upserted) { errors.push(upsertErr?.message || 'Upsert mislukt'); continue; }

      const items = (detail.orderItems || []).map(item => ({
        order_id:      upserted.id,
        store_id:      storeId,
        user_id:       user.id,
        platform:      'bol',
        product_title: item.product?.title || item.offer?.reference || 'Onbekend product',
        product_ean:   item.product?.ean   || null,
        quantity:      item.quantity       || 1,
        unit_price:    item.unitPrice      || 0,
        total_price:   item.totalPrice     || (item.unitPrice * (item.quantity || 1)) || 0
      }));

      await supabase.from('order_items').delete().eq('order_id', upserted.id);
      if (items.length > 0) await supabase.from('order_items').insert(items);
      ordersNew++;
    }
  }

  const hasMore = orderSummaries.length >= 50 && fullSync;
  const nextPage = hasMore ? currentPage + 1 : null;

  if (!hasMore) {
    await supabase.from('stores').update({ last_synced_at: new Date().toISOString() }).eq('id', storeId);
  }

  await supabase.from('sync_log').insert({
    store_id: storeId, user_id: user.id, orders_new: ordersNew,
    status: errors.length > 0 ? 'partial' : 'ok',
    error:  errors.length > 0 ? errors.slice(0, 3).join('; ') : null
  });

  return res.status(200).json({
    message: `Pagina ${currentPage}: ${ordersNew} bestellingen verwerkt.`,
    ordersNew, hasMore, nextPage, page: currentPage
  });
}

async function getBolToken(clientId, clientSecret) {
  try {
    const creds = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const r = await fetch('https://login.bol.com/token?grant_type=client_credentials', {
      method: 'POST',
      headers: { 'Authorization': `Basic ${creds}`, 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    if (!r.ok) return null;
    const d = await r.json();
    return d.access_token;
  } catch { return null; }
}

async function fetchOrderDetail(orderId, headers) {
  try {
    const r = await fetch(`${BASE}/orders/${orderId}`, { headers });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

function calcOrderTotal(items) {
  return items.reduce((sum, item) => sum + (item.totalPrice || (item.unitPrice * (item.quantity || 1)) || 0), 0);
}

function getOrderStatus(items) {
  if (items.some(i => i.cancellationRequest)) return 'cancelled';
  if (items.every(i => i.shipmentDetails?.shipmentDate)) return 'shipped';
  return 'open';
}
