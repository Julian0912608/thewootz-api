// api/sync/bol.js
// mode=orders   → open bestellingen (bol.com max ~48u)
// mode=shipments → historische verzendingen (geen tijdslimiet, gaat jaren terug)
// mode=finalize  → sla last_synced_at op

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

  // ─── MODE: orders ─────────────────────────────────────────────────
  if (mode === 'orders') {
    const r = await fetch(
      `${BASE}/orders?fulfilment-method=ALL&status=ALL&page=${currentPage}`,
      { headers }
    );
    if (!r.ok) {
      const err = await r.text();
      return res.status(r.status).json({ error: `Orders API fout (${r.status})`, detail: err.substring(0, 300) });
    }
    const data      = await r.json();
    const summaries = data.orders || [];
    let ordersNew   = 0;
    const errors    = [];

    for (let i = 0; i < summaries.length; i += 5) {
      const batch   = summaries.slice(i, i + 5);
      const details = await Promise.all(batch.map(o => fetchOrderDetail(o.orderId, headers)));
      for (const detail of details) {
        if (!detail) continue;
        try {
          const ok = await upsertOrder(detail, storeId, user.id, supabase);
          if (ok) ordersNew++;
        } catch(e) { errors.push(e.message); }
      }
    }

    const hasMore = summaries.length >= 50;
    return res.status(200).json({
      ordersNew, hasMore,
      nextPage: hasMore ? currentPage + 1 : null,
      message: `Orders p${currentPage}: ${summaries.length} gevonden, ${ordersNew} opgeslagen`,
      mode: 'orders', errors
    });
  }

  // ─── MODE: shipments ──────────────────────────────────────────────
  // Bol.com shipments endpoint heeft GEEN tijdslimiet — gaat jaren terug
  // Elke pagina = 50 shipments. Frontend loopt door alle pagina's heen.
  if (mode === 'shipments') {
    const r = await fetch(`${BASE}/shipments?page=${currentPage}`, { headers });
    if (!r.ok) {
      const err = await r.text();
      return res.status(r.status).json({ error: `Shipments API fout (${r.status})`, detail: err.substring(0, 300) });
    }
    const data      = await r.json();
    const shipments = data.shipments || [];
    let ordersNew   = 0;
    const errors    = [];

    // Groepeer shipment items per orderId
    const orderMap = {};
    for (const s of shipments) {
      const orderId = s.orderId;
      if (!orderId) continue;

      if (!orderMap[orderId]) {
        // Echte besteldatum: probeer meerdere veldnamen
        const orderDate =
          s.order?.orderPlacedDateTime?.substring(0, 10) ||
          s.orderPlacedDateTime?.substring(0, 10) ||
          s.shipmentDate?.substring(0, 10) ||
          new Date().toISOString().split('T')[0];

        orderMap[orderId] = { orderId, orderDate, items: [] };
      }

      for (const item of (s.shipmentItems || [])) {
        orderMap[orderId].items.push({
          product_title: item.product?.title || item.title || 'Onbekend product',
          product_ean:   item.product?.ean   || item.ean  || null,
          quantity:      item.quantity || 1,
          unit_price:    item.unitPrice || 0,
          total_price:   (item.unitPrice || 0) * (item.quantity || 1)
        });
      }
    }

    for (const order of Object.values(orderMap)) {
      try {
        const totalAmount = order.items.reduce((sum, i) => sum + i.total_price, 0);

        const { data: upserted, error: upsertErr } = await supabase
          .from('orders')
          .upsert({
            store_id:     storeId,
            user_id:      user.id,
            platform:     'bol',
            external_id:  order.orderId,
            order_date:   order.orderDate,
            status:       'shipped',
            total_amount: totalAmount,
            raw_data:     { orderId: order.orderId, orderDate: order.orderDate }
          }, {
            onConflict:      'store_id,external_id',
            ignoreDuplicates: false   // Altijd updaten — corrigeert placeholder datums
          })
          .select('id')
          .single();

        if (upsertErr) { errors.push(`${order.orderId}: ${upsertErr.message}`); continue; }
        if (!upserted) { errors.push(`${order.orderId}: geen id terug`); continue; }

        if (order.items.length > 0) {
          const dbItems = order.items.map(item => ({
            ...item,
            order_id: upserted.id,
            store_id: storeId,
            user_id:  user.id,
            platform: 'bol'
          }));
          await supabase.from('order_items').delete().eq('order_id', upserted.id);
          await supabase.from('order_items').insert(dbItems);
        }
        ordersNew++;
      } catch(e) { errors.push(`${order.orderId}: ${e.message}`); }
    }

    // Bol.com geeft lege array terug als er geen shipments meer zijn
    const hasMore = shipments.length >= 50;

    return res.status(200).json({
      ordersNew, hasMore,
      nextPage: hasMore ? currentPage + 1 : null,
      shipmentsOnPage: shipments.length,
      message: `Shipments p${currentPage}: ${shipments.length} shipments, ${ordersNew} orders opgeslagen`,
      mode: 'shipments', errors: errors.slice(0, 5)
    });
  }

  // ─── MODE: finalize ───────────────────────────────────────────────
  if (mode === 'finalize') {
    await supabase.from('stores')
      .update({ last_synced_at: new Date().toISOString() })
      .eq('id', storeId);
    await supabase.from('sync_log').insert({
      store_id: storeId, user_id: user.id, status: 'ok'
    });
    return res.status(200).json({ message: 'Sync afgerond, last_synced_at bijgewerkt.' });
  }

  return res.status(400).json({ error: `Onbekende mode: ${mode}` });
}

// ─── Hulpfuncties ─────────────────────────────────────────────────────────────

async function upsertOrder(detail, storeId, userId, supabase) {
  const orderDate = (detail.orderPlacedDateTime || '').substring(0, 10)
    || new Date().toISOString().split('T')[0];

  const totalAmount = (detail.orderItems || []).reduce(
    (sum, i) => sum + (i.totalPrice || (i.unitPrice * (i.quantity || 1)) || 0), 0
  );

  const { data: upserted, error } = await supabase.from('orders').upsert({
    store_id:     storeId,
    user_id:      userId,
    platform:     'bol',
    external_id:  detail.orderId,
    order_date:   orderDate,
    status:       getOrderStatus(detail.orderItems || []),
    total_amount: totalAmount,
    raw_data:     detail
  }, { onConflict: 'store_id,external_id', ignoreDuplicates: false })
    .select('id').single();

  if (error || !upserted) return false;

  const items = (detail.orderItems || []).map(item => ({
    order_id:      upserted.id,
    store_id:      storeId,
    user_id:       userId,
    platform:      'bol',
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

async function fetchOrderDetail(orderId, headers) {
  try {
    const r = await fetch(`${BASE}/orders/${orderId}`, { headers });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

async function getBolToken(clientId, clientSecret) {
  try {
    const creds = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const r = await fetch('https://login.bol.com/token?grant_type=client_credentials', {
      method: 'POST',
      headers: {
        'Authorization':  `Basic ${creds}`,
        'Accept':         'application/json',
        'Content-Type':   'application/x-www-form-urlencoded'
      }
    });
    if (!r.ok) return null;
    return (await r.json()).access_token;
  } catch { return null; }
}

function getOrderStatus(items) {
  if (!items?.length) return 'shipped';
  if (items.some(i => i.cancellationRequest)) return 'cancelled';
  if (items.every(i => i.shipmentDetails?.shipmentDate)) return 'shipped';
  return 'open';
}
