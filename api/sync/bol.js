// api/sync/bol.js — Bol.com sync met latest-change-date (week-voor-week)
// Elke call verwerkt 1 week. Frontend roept meerdere keren aan.

import { setCors, getSupabase, getUser } from '../_lib/supabase.js';

const BASE = 'https://api.bol.com/retailer';

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: 'Niet ingelogd' });

  const { storeId, fullSync, weekOffset = 0 } = req.body || {};
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

  // Bepaal de week die we ophalen
  // weekOffset=0 → deze week, weekOffset=1 → vorige week, etc.
  const maxWeeks = fullSync ? 13 : 0; // 13 weken = ~90 dagen
  const currentWeek = parseInt(weekOffset) || 0;

  const endDate   = new Date();
  endDate.setDate(endDate.getDate() - (currentWeek * 7));
  const startDate = new Date(endDate);
  startDate.setDate(startDate.getDate() - 6);

  const startStr = startDate.toISOString().split('T')[0];
  const endStr   = endDate.toISOString().split('T')[0];

  // Haal orders op voor elke dag in deze week
  let ordersNew = 0;
  const errors = [];

  // Loop dag voor dag binnen de week
  const days = getDayRange(startDate, endDate);

  for (const day of days) {
    try {
      const dayOrders = await fetchOrdersForDay(day, headers);

      // Haal details op in batches van 5
      const BATCH = 5;
      for (let i = 0; i < dayOrders.length; i += BATCH) {
        const batch = dayOrders.slice(i, i + BATCH);
        const details = await Promise.all(batch.map(o => fetchOrderDetail(o.orderId, headers)));

        for (const detail of details) {
          if (!detail) continue;

          const orderDate   = (detail.orderPlacedDateTime || day).substring(0, 10);
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

          if (upsertErr || !upserted) continue;

          const items = (detail.orderItems || []).map(item => ({
            order_id:      upserted.id,
            store_id:      storeId,
            user_id:       user.id,
            platform:      'bol',
            product_title: item.product?.title || item.offer?.reference || 'Onbekend',
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
    } catch (e) {
      errors.push(`${day}: ${e.message}`);
    }
  }

  const hasMore = fullSync && currentWeek < maxWeeks;
  const nextWeek = hasMore ? currentWeek + 1 : null;

  if (!hasMore) {
    await supabase.from('stores').update({ last_synced_at: new Date().toISOString() }).eq('id', storeId);
    await supabase.from('sync_log').insert({
      store_id: storeId, user_id: user.id, orders_new: ordersNew,
      status: errors.length > 0 ? 'partial' : 'ok'
    });
  }

  return res.status(200).json({
    message: `Week ${startStr} t/m ${endStr}: ${ordersNew} bestellingen verwerkt.`,
    ordersNew, hasMore, nextWeek,
    weekOffset: currentWeek, period: `${startStr} → ${endStr}`
  });
}

function getDayRange(start, end) {
  const days = [];
  const cur = new Date(start);
  while (cur <= end) {
    days.push(cur.toISOString().split('T')[0]);
    cur.setDate(cur.getDate() + 1);
  }
  return days;
}

async function fetchOrdersForDay(date, headers) {
  try {
    const r = await fetch(
      `${BASE}/orders?fulfilment-method=ALL&latest-change-date=${date}&page=1`,
      { headers }
    );
    if (!r.ok) return [];
    const d = await r.json();
    return d.orders || [];
  } catch { return []; }
}

async function fetchOrderDetail(orderId, headers) {
  try {
    const r = await fetch(`${BASE}/orders/${orderId}`, { headers });
    if (!r.ok) return null;
    return await r.json();
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
