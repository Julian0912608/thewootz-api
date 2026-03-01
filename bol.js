// api/sync/bol.js — Definitieve fix voor bol.com historische data
//
// STRATEGIE: Gebruik latest-change-date parameter om elke dag 
// incrementeel te synchen naar onze eigen database.
// Zo bouwen we een volledige historische dataset op die niet afhankelijk
// is van de 48-uurs window van bol.com.

import { setCors, getSupabase, getUser } from '../_lib/supabase.js';

const BASE = 'https://api.bol.com/retailer';

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: 'Niet ingelogd' });

  const { storeId, fullSync } = req.body || {};
  if (!storeId) return res.status(400).json({ error: 'storeId verplicht' });

  const supabase = getSupabase();

  // Haal store + credentials op
  const { data: store, error: storeErr } = await supabase
    .from('stores')
    .select('*')
    .eq('id', storeId)
    .eq('user_id', user.id)
    .single();

  if (storeErr || !store) return res.status(404).json({ error: 'Store niet gevonden' });
  if (store.platform !== 'bol') return res.status(400).json({ error: 'Alleen bol.com stores' });

  // Decrypt credentials
  const clientId = Buffer.from(store.client_id_enc, 'base64').toString('utf8');
  const clientSecret = Buffer.from(store.client_secret_enc, 'base64').toString('utf8');

  // Haal bol.com token op
  const token = await getBolToken(clientId, clientSecret);
  if (!token) return res.status(401).json({ error: 'Bol.com authenticatie mislukt' });

  const headers = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.retailer.v10+json'
  };

  // Bepaal sync periode
  // - fullSync: pak de laatste 90 dagen (max wat bol.com ondersteunt via latest-change-date)
  // - incrementeel: pak alleen gisteren + vandaag (dagelijkse cron)
  const endDate = new Date();
  const startDate = new Date();
  if (fullSync) {
    startDate.setDate(startDate.getDate() - 89); // 90 dagen terug
  } else {
    startDate.setDate(startDate.getDate() - 2); // gisteren + vandaag
  }

  let ordersNew = 0;
  let ordersUpdated = 0;
  const errors = [];

  // Loop dag voor dag (latest-change-date accepteert 1 datum per keer)
  const days = getDayRange(startDate, endDate);
  
  for (const day of days) {
    try {
      const dayOrders = await fetchOrdersForDay(day, headers);
      
      for (const orderSummary of dayOrders) {
        // Haal order detail op (bevat prijzen + productnamen)
        const detail = await fetchOrderDetail(orderSummary.orderId, headers);
        if (!detail) continue;

        const orderDate = (detail.orderPlacedDateTime || day).substring(0, 10);
        const totalAmount = calcOrderTotal(detail.orderItems || []);

        // Upsert order (insert of update bij duplicate)
        const { data: upserted, error: upsertErr } = await supabase
          .from('orders')
          .upsert({
            store_id: storeId,
            user_id: user.id,
            platform: 'bol',
            external_id: detail.orderId,
            order_date: orderDate,
            status: getOrderStatus(detail.orderItems || []),
            total_amount: totalAmount,
            raw_data: detail
          }, { onConflict: 'store_id,external_id', ignoreDuplicates: false })
          .select('id')
          .single();

        if (upsertErr) { errors.push(upsertErr.message); continue; }

        const orderId = upserted.id;

        // Verwijder oude items + herinsert (eenvoudigste upsert strategie)
        await supabase.from('order_items').delete().eq('order_id', orderId);

        const items = (detail.orderItems || []).map(item => ({
          order_id: orderId,
          store_id: storeId,
          user_id: user.id,
          product_title: item.product?.title || item.offer?.reference || 'Onbekend',
          product_ean: item.product?.ean || null,
          quantity: item.quantity || 1,
          unit_price: item.unitPrice || 0,
          total_price: item.totalPrice || (item.unitPrice * (item.quantity || 1)) || 0,
          platform: 'bol'
        }));

        if (items.length > 0) {
          const { error: itemsErr } = await supabase.from('order_items').insert(items);
          if (itemsErr) errors.push(itemsErr.message);
        }

        ordersNew++;
      }
    } catch (e) {
      errors.push(`Dag ${day}: ${e.message}`);
    }
  }

  // Update last_synced_at op store
  await supabase
    .from('stores')
    .update({ last_synced_at: new Date().toISOString() })
    .eq('id', storeId);

  // Log de sync
  await supabase.from('sync_log').insert({
    store_id: storeId,
    user_id: user.id,
    orders_new: ordersNew,
    status: errors.length > 0 ? 'partial' : 'ok',
    error: errors.length > 0 ? errors.slice(0,3).join('; ') : null
  });

  return res.status(200).json({
    message: `Sync klaar! ${ordersNew} bestellingen gesynchroniseerd.`,
    ordersNew,
    daysChecked: days.length,
    errors: errors.slice(0, 5),
    syncType: fullSync ? 'volledig (90 dagen)' : 'incrementeel (2 dagen)'
  });
}

// ── HELPERS ──────────────────────────────────────────────────

async function getBolToken(clientId, clientSecret) {
  try {
    const creds = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const r = await fetch('https://login.bol.com/token?grant_type=client_credentials', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${creds}`,
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });
    if (!r.ok) return null;
    const d = await r.json();
    return d.access_token;
  } catch { return null; }
}

// Haal alle orders voor een specifieke datum via latest-change-date
async function fetchOrdersForDay(day, headers) {
  const orders = [];
  let page = 1;
  let hasMore = true;

  while (hasMore && page <= 3) {
    const url = `https://api.bol.com/retailer/orders?latest-change-date=${day}&fulfilment-method=ALL&page=${page}`;
    const r = await fetch(url, { headers });
    if (!r.ok) break;
    const d = await r.json();
    const batch = d.orders || [];
    orders.push(...batch);
    hasMore = batch.length >= 100;
    page++;
  }
  return orders;
}

async function fetchOrderDetail(orderId, headers) {
  try {
    const r = await fetch(`https://api.bol.com/retailer/orders/${orderId}`, { headers });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

function calcOrderTotal(items) {
  return items.reduce((sum, item) => {
    return sum + (item.totalPrice || (item.unitPrice * (item.quantity || 1)) || 0);
  }, 0);
}

function getOrderStatus(items) {
  if (items.some(i => i.cancellationRequest)) return 'cancelled';
  if (items.every(i => i.shipmentDetails?.shipmentDate)) return 'shipped';
  return 'open';
}

function getDayRange(start, end) {
  const days = [];
  const cur = new Date(start);
  cur.setHours(0, 0, 0, 0);
  const endTime = new Date(end);
  endTime.setHours(23, 59, 59, 999);
  while (cur <= endTime) {
    days.push(cur.toISOString().split('T')[0]);
    cur.setDate(cur.getDate() + 1);
  }
  return days;
}
