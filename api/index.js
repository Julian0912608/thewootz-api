// api/index.js — Centrale router voor alle endpoints
// Vervangt: auth.js, stores.js, dashboard.js, zoekpositie.js,
//           sync/bol.js, sync/bol-ads.js, debug.js, test-shipments.js
//
// Routes:
//   POST /api?route=auth
//   GET/POST/DELETE /api?route=stores
//   GET /api?route=dashboard
//   GET /api?route=zoekpositie
//   POST /api?route=sync-bol
//   GET/POST /api?route=sync-bol-ads
//   GET /api?route=debug
//   GET /api?route=test-shipments

import { setCors, getSupabase, getUser } from './_lib/supabase.js';
import { createClient } from '@supabase/supabase-js';

const BOL_BASE  = 'https://api.bol.com/retailer';
const ADS_BASE  = 'https://api.bol.com/advertiser/sponsored-products/reporting/performance';
const TOKEN_URL = 'https://login.bol.com/token?grant_type=client_credentials';

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const route = req.query.route || req.query.r || '';

  if (route === 'auth')           return handleAuth(req, res);
  if (route === 'stores')         return handleStores(req, res);
  if (route === 'dashboard')      return handleDashboard(req, res);
  if (route === 'zoekpositie')    return handleZoekpositie(req, res);
  if (route === 'sync-bol')       return handleSyncBol(req, res);
  if (route === 'sync-bol-ads')   return handleSyncBolAds(req, res);
  if (route === 'debug')          return handleDebug(req, res);
  if (route === 'test-shipments') return handleTestShipments(req, res);

  return res.status(404).json({ error: `Onbekende route: ${route}. Gebruik ?route=auth|stores|dashboard|zoekpositie|sync-bol|sync-bol-ads|debug|test-shipments` });
}

// ═══════════════════════════════════════════════════════════════
// AUTH
// ═══════════════════════════════════════════════════════════════
async function handleAuth(req, res) {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
  const { action, email, password, fullName, refreshToken } = req.body || {};

  if (action === 'register') {
    if (!email || !password) return res.status(400).json({ error: 'Email en wachtwoord zijn verplicht' });
    if (password.length < 8) return res.status(400).json({ error: 'Wachtwoord moet minimaal 8 tekens zijn' });
    const { data, error } = await supabase.auth.signUp({ email, password, options: { data: { full_name: fullName || '' } } });
    if (error) return res.status(400).json({ error: error.message });
    return res.status(200).json({ message: 'Account aangemaakt! Check je email.', user: { id: data.user?.id, email: data.user?.email }, session: data.session });
  }

  if (action === 'login') {
    if (!email || !password) return res.status(400).json({ error: 'Email en wachtwoord zijn verplicht' });
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return res.status(401).json({ error: error.message.includes('Invalid login') ? 'Ongeldig email of wachtwoord' : error.message });
    return res.status(200).json({
      user: { id: data.user.id, email: data.user.email, fullName: data.user.user_metadata?.full_name || '' },
      session: { access_token: data.session.access_token, refresh_token: data.session.refresh_token, expires_at: data.session.expires_at }
    });
  }

  if (action === 'refresh') {
    if (!refreshToken) return res.status(400).json({ error: 'Geen refresh token' });
    const { data, error } = await supabase.auth.refreshSession({ refresh_token: refreshToken });
    if (error) return res.status(401).json({ error: 'Sessie verlopen, log opnieuw in' });
    return res.status(200).json({ session: { access_token: data.session.access_token, refresh_token: data.session.refresh_token, expires_at: data.session.expires_at } });
  }

  if (action === 'logout') return res.status(200).json({ message: 'Uitgelogd' });
  return res.status(400).json({ error: 'Onbekende actie' });
}

// ═══════════════════════════════════════════════════════════════
// STORES
// ═══════════════════════════════════════════════════════════════
async function handleStores(req, res) {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: 'Niet ingelogd' });
  const supabase = getSupabase();

  if (req.method === 'GET') {
    const { data, error } = await supabase.from('stores').select('id, platform, name, is_active, last_synced_at, created_at').eq('user_id', user.id).order('created_at', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ stores: data || [] });
  }

  if (req.method === 'POST') {
    const { platform, name, clientId, clientSecret } = req.body || {};
    if (!platform || !clientId || !clientSecret) return res.status(400).json({ error: 'Platform, clientId en clientSecret zijn verplicht' });
    if (platform === 'bol') {
      const token = await getBolToken(clientId, clientSecret);
      if (!token) return res.status(400).json({ error: 'Bol.com credentials ongeldig. Controleer je Client ID en Secret.' });
    }
    const { data, error } = await supabase.from('stores').insert({
      user_id: user.id, platform, name: name || `Mijn ${platform} winkel`,
      client_id_enc: Buffer.from(clientId).toString('base64'),
      client_secret_enc: Buffer.from(clientSecret).toString('base64')
    }).select('id, platform, name, created_at').single();
    if (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'Deze winkel is al gekoppeld' });
      return res.status(500).json({ error: error.message });
    }
    return res.status(201).json({ store: data, message: 'Winkel succesvol gekoppeld!' });
  }

  if (req.method === 'DELETE') {
    const storeId = req.query.id;
    if (!storeId) return res.status(400).json({ error: 'Store ID verplicht' });
    const { error } = await supabase.from('stores').delete().eq('id', storeId).eq('user_id', user.id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ message: 'Winkel verwijderd' });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

// ═══════════════════════════════════════════════════════════════
// DASHBOARD
// ═══════════════════════════════════════════════════════════════
async function handleDashboard(req, res) {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: 'Niet ingelogd' });
  const supabase = getSupabase();

  const { storeId, startDate, endDate, platform, compareMode: cm } = req.query;
  const end   = endDate   || new Date().toISOString().split('T')[0];
  const start = startDate || new Date(Date.now() - 90 * 86400000).toISOString().split('T')[0];
  const compareMode = parseInt(cm || '0');

  const startDt = new Date(start), endDt = new Date(end), diffMs = endDt - startDt;
  let cmpStart, cmpEnd;
  if (compareMode === 0) { cmpEnd = new Date(startDt - 86400000); cmpStart = new Date(cmpEnd - diffMs); }
  else if (compareMode === 1) { cmpStart = new Date(startDt); cmpStart.setFullYear(cmpStart.getFullYear()-1); cmpEnd = new Date(endDt); cmpEnd.setFullYear(cmpEnd.getFullYear()-1); }
  const cmpStartStr = cmpStart?.toISOString().split('T')[0];
  const cmpEndStr   = cmpEnd?.toISOString().split('T')[0];

  let storeQuery = supabase.from('stores').select('id, platform, name').eq('user_id', user.id).eq('is_active', true);
  if (storeId) storeQuery = storeQuery.eq('id', storeId);
  if (platform) storeQuery = storeQuery.eq('platform', platform);
  const { data: stores } = await storeQuery;

  if (!stores?.length) return res.status(200).json({ samenvatting: { totalBestellingen: 0, totalOmzet: 0, gemOmzetPerBestelling: 0, periode: { start, end } }, topProducten: [], perDag: [], stores: [], message: 'Geen actieve winkels' });

  const storeIds = storeId ? [storeId] : stores.map(s => s.id);

  const { data: orders } = await supabase.from('orders')
    .select('id, external_id, order_date, total_amount, platform, status')
    .in('store_id', storeIds).eq('user_id', user.id)
    .gte('order_date', start).lte('order_date', end)
    .order('order_date', { ascending: false });

  const orderIds = (orders || []).map(o => o.id);
  let filteredItems = [];
  for (let i = 0; i < orderIds.length; i += 500) {
    const { data: chunk } = await supabase.from('order_items')
      .select('product_title, product_ean, quantity, total_price, platform, store_id, order_id')
      .in('order_id', orderIds.slice(i, i + 500)).eq('user_id', user.id);
    if (chunk) filteredItems = filteredItems.concat(chunk);
  }

  const BTW = 1.21, exBtw = b => b / BTW;
  const totalBestellingen = (orders || []).length;
  const totalOmzet = (orders || []).reduce((sum, o) => sum + exBtw(o.total_amount || 0), 0);

  const productMap = {};
  filteredItems.forEach(item => {
    const key = item.product_ean || item.product_title || 'unknown';
    if (!productMap[key]) productMap[key] = { titel: item.product_title || 'Onbekend', ean: item.product_ean, stuks: 0, omzet: 0 };
    productMap[key].stuks += item.quantity || 1;
    productMap[key].omzet += exBtw(item.total_price || 0);
  });

  const dagMap = {};
  (orders || []).forEach(o => {
    if (!dagMap[o.order_date]) dagMap[o.order_date] = { datum: o.order_date, bestellingen: 0, omzet: 0 };
    dagMap[o.order_date].bestellingen++;
    dagMap[o.order_date].omzet += exBtw(o.total_amount || 0);
  });

  const allDays = getAllDays(start, end);
  const perDag  = allDays.map(d => dagMap[d] || { datum: d, bestellingen: 0, omzet: 0 });

  let vergelijking = null;
  if (compareMode < 2 && cmpStartStr && cmpEndStr) {
    const { data: cmpOrders } = await supabase.from('orders').select('id, order_date, total_amount')
      .in('store_id', storeIds).eq('user_id', user.id).gte('order_date', cmpStartStr).lte('order_date', cmpEndStr);
    const cmpTotal = (cmpOrders || []).reduce((sum, o) => sum + exBtw(o.total_amount || 0), 0);
    const cmpCount = (cmpOrders || []).length;
    const cmpDagMap = {};
    (cmpOrders || []).forEach(o => { if (!cmpDagMap[o.order_date]) cmpDagMap[o.order_date] = { datum: o.order_date, bestellingen: 0, omzet: 0 }; cmpDagMap[o.order_date].bestellingen++; cmpDagMap[o.order_date].omzet += exBtw(o.total_amount || 0); });
    const cmpDays = getAllDays(cmpStartStr, cmpEndStr);
    vergelijking = {
      samenvatting: { totalBestellingen: cmpCount, totalOmzet: Math.round(cmpTotal*100)/100, gemOmzetPerBestelling: cmpCount > 0 ? Math.round(cmpTotal/cmpCount*100)/100 : 0, periode: { start: cmpStartStr, end: cmpEndStr } },
      perDag: allDays.map((_, i) => { const d = cmpDays[i]; return d ? (cmpDagMap[d] || { datum: d, bestellingen: 0, omzet: 0 }) : { datum: '', bestellingen: 0, omzet: 0 }; })
    };
  }

  return res.status(200).json({
    samenvatting: { totalBestellingen, totalOmzet: Math.round(totalOmzet*100)/100, gemOmzetPerBestelling: totalBestellingen > 0 ? Math.round(totalOmzet/totalBestellingen*100)/100 : 0, periode: { start, end } },
    topProducten: Object.values(productMap).sort((a,b) => b.omzet - a.omzet).slice(0, 10),
    perDag, stores, vergelijking,
    _debug: { start, end, storeIds, totalOrdersFound: (orders || []).length },
    opgehaaldUitDatabase: true, opgehaaldOp: new Date().toISOString()
  });
}

// ═══════════════════════════════════════════════════════════════
// ZOEKPOSITIE
// ═══════════════════════════════════════════════════════════════
async function handleZoekpositie(req, res) {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: 'Niet ingelogd' });
  const supabase = getSupabase();
  const { term, storeId } = req.query;
  if (!term) return res.status(400).json({ error: 'term parameter verplicht' });

  const q = supabase.from('stores').select('*').eq('user_id', user.id).eq('platform', 'bol').eq('is_active', true);
  const { data: stores } = storeId ? await q.eq('id', storeId).limit(1) : await q.limit(1);
  const store = stores?.[0];
  if (!store) return res.status(404).json({ error: 'Geen bol.com winkel gevonden.' });

  const clientId     = Buffer.from(store.client_id_enc,     'base64').toString('utf8');
  const clientSecret = Buffer.from(store.client_secret_enc, 'base64').toString('utf8');
  const token        = await getBolToken(clientId, clientSecret);
  if (!token) return res.status(401).json({ error: 'Bol.com authenticatie mislukt' });

  const headers = { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.retailer.v10+json' };
  const isEan = /^\d{8,14}$/.test(term.replace(/\s/g, ''));
  let url = `${BOL_BASE}/offers?status=ACTIVE&limit=50`;
  if (isEan) url += `&ean=${term.replace(/\s/g, '')}`;
  const r = await fetch(url, { headers });
  if (!r.ok) { const err = await r.text(); return res.status(200).json({ positie: null, term, error: `Bol.com API fout (${r.status})`, detail: err.substring(0, 200) }); }

  const { offers = [] } = await r.json();
  const filtered = isEan ? offers : offers.filter(o => o.ean?.includes(term) || o.reference?.toLowerCase().includes(term.toLowerCase()));

  if (!filtered.length) {
    const { data: items } = await supabase.from('order_items').select('product_title, product_ean, quantity').eq('user_id', user.id).ilike('product_ean', `%${term}%`).limit(5);
    if (items?.length) return res.status(200).json({ ean: items[0].product_ean, titel: items[0].product_title, positie: null, bron: 'database', verkochtStuks: items.reduce((s,i) => s+i.quantity, 0), tip: `EAN gevonden in verkoophistorie. Zoekpositie niet beschikbaar via API.` });
    return res.status(200).json({ positie: null, term, melding: `Geen actief aanbod gevonden voor "${term}".` });
  }

  const offer = filtered[0];
  return res.status(200).json({ ean: offer.ean, titel: offer.reference || offer.ean, positie: null, prijs: offer.pricing?.bundlePrices?.[0]?.price || null, voorraad: offer.stock?.amount || 0, status: offer.status || 'ACTIVE', fulfillment: offer.fulfilment?.method || 'FBR', aantalGevonden: filtered.length });
}

// ═══════════════════════════════════════════════════════════════
// SYNC BOL
// ═══════════════════════════════════════════════════════════════
async function handleSyncBol(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST vereist' });
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: 'Niet ingelogd' });
  const supabase = getSupabase();

  const { storeId, mode = 'orders', page = 1 } = req.body || {};
  if (!storeId) return res.status(400).json({ error: 'storeId verplicht' });

  const { data: store } = await supabase.from('stores').select('*').eq('id', storeId).eq('user_id', user.id).single();
  if (!store) return res.status(404).json({ error: 'Store niet gevonden' });

  const clientId     = Buffer.from(store.client_id_enc,     'base64').toString('utf8');
  const clientSecret = Buffer.from(store.client_secret_enc, 'base64').toString('utf8');
  const token        = await getBolToken(clientId, clientSecret);
  if (!token) return res.status(401).json({ error: 'Bol.com authenticatie mislukt' });

  const headers = { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.retailer.v10+json' };
  const currentPage = parseInt(page) || 1;

  if (mode === 'orders') {
    const r = await fetch(`${BOL_BASE}/orders?fulfilment-method=ALL&status=ALL&page=${currentPage}`, { headers });
    if (!r.ok) { const err = await r.text(); return res.status(r.status).json({ error: `Orders API fout (${r.status})`, detail: err.substring(0, 300) }); }
    const { orders: summaries = [] } = await r.json();
    let ordersNew = 0, errors = [];
    for (let i = 0; i < summaries.length; i += 5) {
      const details = await Promise.all(summaries.slice(i, i+5).map(o => fetchOrderDetail(o.orderId, headers)));
      for (const d of details) {
        if (!d) continue;
        try { if (await upsertOrder(d, storeId, user.id, supabase)) ordersNew++; } catch(e) { errors.push(e.message); }
      }
    }
    const hasMore = summaries.length >= 50;
    return res.status(200).json({ ordersNew, hasMore, nextPage: hasMore ? currentPage+1 : null, message: `Orders p${currentPage}: ${summaries.length} gevonden, ${ordersNew} opgeslagen`, mode: 'orders', errors });
  }

  if (mode === 'shipments') {
    const r = await fetch(`${BOL_BASE}/shipments?page=${currentPage}`, { headers });
    if (!r.ok) { const err = await r.text(); return res.status(r.status).json({ error: `Shipments API fout (${r.status})`, detail: err.substring(0, 300) }); }
    
    const rawData = await r.json();
    const shipments = rawData.shipments || [];
    
    // DEBUG: toon ruwe structuur van eerste shipment
    const firstShipment = shipments[0] || null;
    const debugInfo = firstShipment ? {
      keys: Object.keys(firstShipment),
      orderId: firstShipment.orderId,
      shipmentDate: firstShipment.shipmentDate,
      hasOrder: !!firstShipment.order,
      orderKeys: firstShipment.order ? Object.keys(firstShipment.order) : [],
      orderPlacedDateTime: firstShipment.order?.orderPlacedDateTime,
      itemCount: (firstShipment.shipmentItems || []).length,
      firstItem: firstShipment.shipmentItems?.[0] ? {
        keys: Object.keys(firstShipment.shipmentItems[0]),
        product: firstShipment.shipmentItems[0].product,
        unitPrice: firstShipment.shipmentItems[0].unitPrice,
        quantity: firstShipment.shipmentItems[0].quantity,
      } : null
    } : null;

    let ordersNew = 0, errors = [];
    const orderMap = {};

    for (const s of shipments) {
      // orderId zit in s.order.orderId, NIET in s.orderId
      const orderId = s.order?.orderId || s.orderId;
      if (!orderId) continue;

      if (!orderMap[orderId]) {
        const orderDate =
          s.order?.orderPlacedDateTime?.substring(0,10) ||
          s.orderPlacedDateTime?.substring(0,10) ||
          s.shipmentDateTime?.substring(0,10) ||
          new Date().toISOString().split('T')[0];
        orderMap[orderId] = { orderId, orderDate, items: [] };
      }

      for (const item of (s.shipmentItems || [])) {
        // Items hebben alleen orderItemId + ean — rest ophalen we niet (geen prijs beschikbaar)
        // We slaan toch op met ean als identifier, prijs=0 (wordt later via orders-mode bijgewerkt)
        orderMap[orderId].items.push({
          product_title: item.product?.title || item.title || `EAN: ${item.ean || 'Onbekend'}`,
          product_ean:   item.ean || item.product?.ean || null,
          quantity:      item.quantity  || 1,
          unit_price:    item.unitPrice || 0,
          total_price:   (item.unitPrice || 0) * (item.quantity || 1)
        });
      }
    }

    const orderList = Object.values(orderMap);

    for (const order of orderList) {
      try {
        const totalAmount = order.items.reduce((sum, i) => sum + i.total_price, 0);

        // INSERT OR UPDATE — gebruik insert met onConflict do update
        const { data: inserted, error: insErr } = await supabase
          .from('orders')
          .insert({
            store_id:     storeId,
            user_id:      user.id,
            platform:     'bol',
            external_id:  order.orderId,
            order_date:   order.orderDate,
            status:       'shipped',
            total_amount: totalAmount,
            raw_data:     { orderId: order.orderId, orderDate: order.orderDate }
          })
          .select('id')
          .single();

        let rowId = inserted?.id;

        // Als insert faalt door duplicate, doe een update + select
        if (insErr) {
          const { data: updated, error: updErr } = await supabase
            .from('orders')
            .update({ order_date: order.orderDate, status: 'shipped', total_amount: totalAmount })
            .eq('store_id', storeId)
            .eq('external_id', order.orderId)
            .select('id')
            .single();
          if (updErr) { errors.push(`${order.orderId} update: ${updErr.message}`); continue; }
          rowId = updated?.id;
        }

        if (!rowId) { errors.push(`${order.orderId}: geen rowId na insert/update`); continue; }

        if (order.items.length > 0) {
          await supabase.from('order_items').delete().eq('order_id', rowId);
          const { error: itemErr } = await supabase.from('order_items').insert(
            order.items.map(item => ({ ...item, order_id: rowId, store_id: storeId, user_id: user.id, platform: 'bol' }))
          );
          if (itemErr) errors.push(`${order.orderId} items: ${itemErr.message}`);
        }
        ordersNew++;
      } catch(e) { errors.push(`${order.orderId}: ${e.message}`); }
    }

    const hasMore = shipments.length >= 50;
    return res.status(200).json({
      ordersNew, hasMore,
      nextPage: hasMore ? currentPage+1 : null,
      shipmentsOnPage: shipments.length,
      uniqueOrders: orderList.length,
      message: `Shipments p${currentPage}: ${shipments.length} shipments → ${orderList.length} orders → ${ordersNew} opgeslagen`,
      mode: 'shipments',
      errors,           // Alle errors, niet gesliced
      debugFirstShipment: currentPage === 1 ? debugInfo : undefined
    });
  }

  if (mode === 'finalize') {
    await supabase.from('stores').update({ last_synced_at: new Date().toISOString() }).eq('id', storeId);
    await supabase.from('sync_log').insert({ store_id: storeId, user_id: user.id, status: 'ok' });
    return res.status(200).json({ message: 'Sync afgerond.' });
  }

  return res.status(400).json({ error: `Onbekende mode: ${mode}` });
}

// ═══════════════════════════════════════════════════════════════
// SYNC BOL-ADS
// ═══════════════════════════════════════════════════════════════
async function handleSyncBolAds(req, res) {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: 'Niet ingelogd' });
  const supabase = getSupabase();

  if (req.method === 'POST') {
    const { storeId, adsClientId, adsClientSecret } = req.body || {};
    if (!storeId || !adsClientId || !adsClientSecret) return res.status(400).json({ error: 'storeId, adsClientId en adsClientSecret zijn verplicht' });
    const { data: store } = await supabase.from('stores').select('id').eq('id', storeId).eq('user_id', user.id).single();
    if (!store) return res.status(404).json({ error: 'Store niet gevonden' });
    const token = await getAdsToken(adsClientId, adsClientSecret);
    if (!token) return res.status(401).json({ error: 'Ongeldige advertising credentials.' });
    const { error } = await supabase.from('stores').update({ ads_client_id_enc: Buffer.from(adsClientId).toString('base64'), ads_client_secret_enc: Buffer.from(adsClientSecret).toString('base64') }).eq('id', storeId);
    if (error) return res.status(500).json({ error: 'Opslaan mislukt: ' + error.message });
    return res.status(200).json({ message: 'Advertising credentials opgeslagen!' });
  }

  if (req.method === 'GET') {
    const { storeId, startDate, endDate } = req.query;
    const q = supabase.from('stores').select('*').eq('user_id', user.id).eq('platform', 'bol').eq('is_active', true);
    const { data: stores } = storeId ? await q.eq('id', storeId).limit(1) : await q.limit(1);
    const store = stores?.[0];
    if (!store) return res.status(404).json({ error: 'Geen winkel gevonden' });
    if (!store.ads_client_id_enc) return res.status(404).json({ error: 'no_ads_credentials', message: 'Geen advertising credentials.' });

    const adsClientId     = Buffer.from(store.ads_client_id_enc,     'base64').toString('utf8');
    const adsClientSecret = Buffer.from(store.ads_client_secret_enc, 'base64').toString('utf8');
    const token           = await getAdsToken(adsClientId, adsClientSecret);
    if (!token) return res.status(401).json({ error: 'Advertising API authenticatie mislukt.' });

    const end   = endDate   || new Date().toISOString().split('T')[0];
    const start = startDate || new Date(Date.now() - 30*86400000).toISOString().split('T')[0];
    const params = `period-start-date=${start}&period-end-date=${end}`;
    const headers = { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.advertiser.v11+json', 'Content-Type': 'application/vnd.advertiser.v11+json' };

    const [totR, searchR, catR] = await Promise.all([
      fetch(`${ADS_BASE}/advertiser?${params}`, { headers }),
      fetch(`${ADS_BASE}/advertiser/search-terms?${params}&page=1&page-size=20`, { headers }),
      fetch(`${ADS_BASE}/advertiser/categories?${params}&page=1&page-size=10`, { headers }),
    ]);

    if (!totR.ok) {
      let errBody = ''; try { errBody = await totR.text(); } catch {}
      return res.status(totR.status).json({ error: `Reporting API fout (${totR.status})`, detail: errBody.substring(0, 500), tip: totR.status === 400 ? 'Controleer datumformaat of verklein de periode' : totR.status === 403 ? 'Controleer advertising scope' : undefined });
    }
    const totals = await totR.json();

    let searchTerms = [], categories = [];
    if (searchR.ok) { const sd = await searchR.json(); searchTerms = (sd.searchTermPerformances || sd.performances || sd.items || []).sort((a,b) => (b.clicks||0)-(a.clicks||0)).slice(0,20); }
    if (catR.ok)    { const cd = await catR.json();    categories  = (cd.categoryPerformances  || cd.performances || cd.items || []).sort((a,b) => (b.impressions||0)-(a.impressions||0)).slice(0,10); }

    // Per-dag (alleen bij ≤14 dagen)
    const startDt = new Date(start), endDt = new Date(end);
    const diffDays = Math.round((endDt - startDt) / 86400000) + 1;
    const dagData = [];
    if (diffDays <= 14) {
      for (let i = 0; i < diffDays; i++) {
        const d = new Date(startDt); d.setDate(d.getDate() + i);
        const dag = d.toISOString().split('T')[0];
        try {
          const r = await fetch(`${ADS_BASE}/advertiser?period-start-date=${dag}&period-end-date=${dag}`, { headers });
          dagData.push(r.ok ? { datum: dag, ...(await r.json()) } : { datum: dag, cost: 0, clicks: 0, impressions: 0, conversions14d: 0, sales14d: 0 });
        } catch { dagData.push({ datum: dag, cost: 0, clicks: 0, impressions: 0, conversions14d: 0, sales14d: 0 }); }
      }
    }

    return res.status(200).json({
      totals: { impressions: totals.impressions||0, clicks: totals.clicks||0, ctr: totals.ctr||0, conversions: totals.conversions14d||0, directConversions: totals.directConversions14d||0, averageCpc: totals.averageCpc||0, sales: totals.sales14d||0, cost: totals.cost||0, acos: totals.acos14d||0, roas: totals.roas14d||0 },
      searchTerms, searchTermsRaw: searchTerms,
      categories, perDag: dagData,
      periode: { start, end, days: diffDays }
    });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

// ═══════════════════════════════════════════════════════════════
// DEBUG
// ═══════════════════════════════════════════════════════════════
async function handleDebug(req, res) {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: 'Niet ingelogd' });
  const supabase = getSupabase();

  const { data: stores } = await supabase.from('stores').select('id, name, platform, last_synced_at').eq('user_id', user.id);
  if (!stores?.length) return res.status(200).json({ stores: [], orders: [], message: 'Geen winkels' });

  const storeIds = stores.map(s => s.id);
  const { data: orders, error: ordErr } = await supabase.from('orders').select('id, external_id, order_date, total_amount, status, created_at').in('store_id', storeIds).order('order_date', { ascending: false }).limit(200);

  const perDatum = {};
  for (const o of (orders || [])) { const d = o.order_date; perDatum[d] = (perDatum[d]||0) + 1; }
  const dates = Object.keys(perDatum).sort();

  return res.status(200).json({
    stores, totalOrders: (orders||[]).length, vroegste: dates[0]||null, laatste: dates[dates.length-1]||null,
    perDatum: Object.fromEntries(Object.entries(perDatum).slice(-30)),
    eersteOrders: (orders||[]).slice(0,5).map(o => ({ external_id: o.external_id, order_date: o.order_date, total_amount: o.total_amount, status: o.status, created_at: o.created_at })),
    supabaseError: ordErr?.message || null
  });
}

// ═══════════════════════════════════════════════════════════════
// TEST SHIPMENTS
// ═══════════════════════════════════════════════════════════════
async function handleTestShipments(req, res) {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: 'Niet ingelogd' });
  const supabase = getSupabase();

  const { data: stores } = await supabase.from('stores').select('*').eq('user_id', user.id).eq('platform', 'bol').limit(1);
  const store = stores?.[0];
  if (!store) return res.status(404).json({ error: 'Geen bol winkel gevonden' });

  const clientId     = Buffer.from(store.client_id_enc,     'base64').toString('utf8');
  const clientSecret = Buffer.from(store.client_secret_enc, 'base64').toString('utf8');
  const token        = await getBolToken(clientId, clientSecret);
  if (!token) return res.status(401).json({ error: 'Token mislukt' });

  const page = parseInt(req.query.page || '1');
  const headers = { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.retailer.v10+json' };
  const shipR = await fetch(`${BOL_BASE}/shipments?page=${page}`, { headers });
  if (!shipR.ok) { const err = await shipR.text(); return res.status(shipR.status).json({ error: `Shipments API fout (${shipR.status})`, detail: err.substring(0, 500) }); }

  const { shipments = [] } = await shipR.json();
  const orderDates = shipments.map(s => ({
    orderId:   s.order?.orderId || s.orderId || '(geen orderId)',
    shipDate:  s.shipmentDateTime?.substring(0,10) || s.shipmentDate?.substring(0,10),
    orderDate: s.order?.orderPlacedDateTime?.substring(0,10) || '(niet beschikbaar)',
    itemCount: (s.shipmentItems||[]).length,
    itemKeys:  s.shipmentItems?.[0] ? Object.keys(s.shipmentItems[0]) : []
  }));
  const validDates = orderDates.map(o => o.orderDate).filter(d => d !== '(niet beschikbaar)').sort();

  return res.status(200).json({ page, shipmentsOpPagina: shipments.length, heeftMeerPaginas: shipments.length >= 50, vroegste: validDates[0]||'?', laatste: validDates[validDates.length-1]||'?', orders: orderDates });
}

// ═══════════════════════════════════════════════════════════════
// GEDEELDE HULPFUNCTIES
// ═══════════════════════════════════════════════════════════════
async function getBolToken(clientId, clientSecret) {
  try {
    const creds = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const r = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Authorization': `Basic ${creds}`, 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' } });
    if (!r.ok) return null;
    return (await r.json()).access_token;
  } catch { return null; }
}

async function getAdsToken(clientId, clientSecret) {
  return getBolToken(clientId, clientSecret); // Zelfde token flow
}

async function fetchOrderDetail(orderId, headers) {
  try { const r = await fetch(`${BOL_BASE}/orders/${orderId}`, { headers }); return r.ok ? await r.json() : null; } catch { return null; }
}

async function upsertOrder(detail, storeId, userId, supabase) {
  const orderDate = (detail.orderPlacedDateTime || '').substring(0,10) || new Date().toISOString().split('T')[0];
  const totalAmount = (detail.orderItems || []).reduce((sum, i) => sum + (i.totalPrice || (i.unitPrice*(i.quantity||1)) || 0), 0);
  const { data: upserted, error } = await supabase.from('orders').upsert({
    store_id: storeId, user_id: userId, platform: 'bol', external_id: detail.orderId,
    order_date: orderDate, status: getOrderStatus(detail.orderItems||[]), total_amount: totalAmount, raw_data: detail
  }, { onConflict: 'store_id,external_id', ignoreDuplicates: false }).select('id').single();
  if (error || !upserted) return false;
  const items = (detail.orderItems || []).map(item => ({ order_id: upserted.id, store_id: storeId, user_id: userId, platform: 'bol', product_title: item.product?.title || item.offer?.reference || 'Onbekend', product_ean: item.product?.ean || null, quantity: item.quantity || 1, unit_price: item.unitPrice || 0, total_price: item.totalPrice || (item.unitPrice*(item.quantity||1)) || 0 }));
  await supabase.from('order_items').delete().eq('order_id', upserted.id);
  if (items.length > 0) await supabase.from('order_items').insert(items);
  return true;
}

function getOrderStatus(items) {
  if (!items?.length) return 'shipped';
  if (items.some(i => i.cancellationRequest)) return 'cancelled';
  if (items.every(i => i.shipmentDetails?.shipmentDate)) return 'shipped';
  return 'open';
}

function getAllDays(start, end) {
  const days = [], cur = new Date(start), endDt = new Date(end);
  while (cur <= endDt) { days.push(cur.toISOString().split('T')[0]); cur.setDate(cur.getDate()+1); }
  return days;
}
