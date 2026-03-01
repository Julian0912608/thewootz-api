// api/sync/bol.js — Definitieve aanpak
// 1. Haal ALLE orders op via standaard endpoint (paginering) — open + recent shipped
// 2. Gebruik latest-change-date per DAG voor historische shipped orders
// Elke call doet 1 pagina OF 1 dag, zodat we nooit timeout krijgen.

import { setCors, getSupabase, getUser } from '../_lib/supabase.js';

const BASE = 'https://api.bol.com/retailer';

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: 'Niet ingelogd' });

  const { storeId, mode = 'page', page = 1, date } = req.body || {};
  if (!storeId) return res.status(400).json({ error: 'storeId verplicht' });

  const supabase = getSupabase();
  const { data: store } = await supabase
    .from('stores').select('*').eq('id', storeId).eq('user_id', user.id).single();

  if (!store) return res.status(404).json({ error: 'Store niet gevonden' });
  if (store.platform !== 'bol') return res.status(400).json({ error: 'Alleen bol.com stores' });

  const clientId     = Buffer.from(store.client_id_enc,     'base64').toString('utf8');
  const clientSecret = Buffer.from(store.client_secret_enc, 'base64').toString('utf8');

  const token = await getBolToken(clientId, clientSecret);
  if (!token) return res.status(401).json({ error: 'Bol.com authenticatie mislukt' });

  const headers = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.retailer.v10+json'
  };

  // ── MODE: page — haal 1 pagina orders op (standaard endpoint) ──
  if (mode === 'page') {
    const currentPage = parseInt(page) || 1;
    const r = await fetch(`${BASE}/orders?fulfilment-method=ALL&status=ALL&page=${currentPage}`, { headers });

    if (!r.ok) {
      const err = await r.text();
      return res.status(r.status).json({ error: `Bol.com API fout (${r.status})`, detail: err.substring(0, 200) });
    }

    const data = await r.json();
    const summaries = data.orders || [];
    const ordersNew = await processOrders(summaries, storeId, user.id, headers, supabase);
    const hasMore = summaries.length >= 50;

    if (!hasMore) {
      await supabase.from('stores').update({ last_synced_at: new Date().toISOString() }).eq('id', storeId);
    }

    return res.status(200).json({
      message: `Pagina ${currentPage}: ${ordersNew} bestellingen verwerkt.`,
      ordersNew, hasMore, nextPage: hasMore ? currentPage + 1 : null, mode: 'page'
    });
  }

  // ── MODE: date — haal orders op voor 1 specifieke datum ──
  if (mode === 'date' && date) {
    const r = await fetch(`${BASE}/orders?fulfilment-method=ALL&latest-change-date=${date}&page=1`, { headers });
    const data = r.ok ? await r.json() : { orders: [] };
    const summaries = data.orders || [];
    const ordersNew = await processOrders(summaries, storeId, user.id, headers, supabase);

    return res.status(200).json({
      message: `${date}: ${ordersNew} bestellingen verwerkt.`,
      ordersNew, date, mode: 'date'
    });
  }

  // ── MODE: finalize — markeer sync als klaar ──
  if (mode === 'finalize') {
    await supabase.from('stores').update({ last_synced_at: new Date().toISOString() }).eq('id', storeId);
    await supabase.from('sync_log').insert({ store_id: storeId, user_id: user.id, status: 'ok' });
    return res.status(200).json({ message: 'Sync afgerond.' });
  }

  return res.status(400).json({ error: 'Onbekende mode' });
}

async function processOrders(summaries, storeId, userId, headers, supabase) {
  let count = 0;
  const BATCH = 5;

  for (let i = 0; i < summaries.length; i += BATCH) {
    const batch = summaries.slice(i, i + BATCH);
    const details = await Promise.all(batch.map(o => fetchOrderDetail(o.orderId, headers)));

    for (const detail of details) {
      if (!detail) continue;

      const orderDate   = (detail.orderPlacedDateTime || '').substring(0, 10) || new Date().toISOString().split('T')[0];
      const totalAmount = calcOrderTotal(detail.orderItems || []);

      const { data: upserted } = await supabase.from('orders').upsert({
        store_id: storeId, user_id: userId, platform: 'bol',
        external_id: detail.orderId, order_date: orderDate,
        status: getOrderStatus(detail.orderItems || []),
        total_amount: totalAmount, raw_data: detail
      }, { onConflict: 'store_id,external_id', ignoreDuplicates: false }).select('id').single();

      if (!upserted) continue;

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
      count++;
    }
  }
  return count;
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

function calcOrderTotal(items) {
  return items.reduce((sum, i) => sum + (i.totalPrice || (i.unitPrice * (i.quantity || 1)) || 0), 0);
}

function getOrderStatus(items) {
  if (items.some(i => i.cancellationRequest)) return 'cancelled';
  if (items.every(i => i.shipmentDetails?.shipmentDate)) return 'shipped';
  return 'open';
}
