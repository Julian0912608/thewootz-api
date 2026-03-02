// api/dashboard.js — Dashboard data uit database (niet live bol.com API)
// Dit is de oplossing voor het 48-uurs probleem.
// Data komt uit onze eigen Supabase database die dagelijks gesynchroniseerd wordt.

import { setCors, getSupabase, getUser } from './_lib/supabase.js';

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: 'Niet ingelogd' });

  const supabase = getSupabase();
  const { storeId, startDate, endDate, platform } = req.query;

  const end   = endDate   || new Date().toISOString().split('T')[0];
  const start = startDate || new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
  const compareMode = parseInt(req.query.compareMode || '0');

  // Bereken vergelijkperiode
  const startDt = new Date(start);
  const endDt   = new Date(end);
  const diffMs  = endDt - startDt;
  let cmpStart, cmpEnd;
  if (compareMode === 0) { // vorige periode
    cmpEnd   = new Date(startDt - 86400000);
    cmpStart = new Date(cmpEnd - diffMs);
  } else if (compareMode === 1) { // vorig jaar
    cmpStart = new Date(startDt); cmpStart.setFullYear(cmpStart.getFullYear() - 1);
    cmpEnd   = new Date(endDt);   cmpEnd.setFullYear(cmpEnd.getFullYear() - 1);
  }
  const cmpStartStr = cmpStart?.toISOString().split('T')[0];
  const cmpEndStr   = cmpEnd?.toISOString().split('T')[0];

  // Bouw query op
  let storeQuery = supabase.from('stores').select('id, platform, name').eq('user_id', user.id).eq('is_active', true);
  if (storeId) storeQuery = storeQuery.eq('id', storeId);
  if (platform) storeQuery = storeQuery.eq('platform', platform);

  const { data: stores } = await storeQuery;
  if (!stores || stores.length === 0) {
    return res.status(200).json({ 
      samenvatting: { totalBestellingen: 0, totalOmzet: 0, gemOmzetPerBestelling: 0, periode: { start, end } },
      topProducten: [], perDag: [], stores: [], message: 'Geen actieve winkels gevonden'
    });
  }

  const storeIds = storeId ? [storeId] : stores.map(s => s.id);

  // ── BESTELLINGEN ─────────────────────────────────────────
  const { data: orders } = await supabase
    .from('orders')
    .select('id, external_id, order_date, total_amount, platform, status')
    .in('store_id', storeIds)
    .eq('user_id', user.id)
    .gte('order_date', start)
    .lte('order_date', end)
    .order('order_date', { ascending: false });

  // ── ORDER ITEMS ───────────────────────────────────────────
  // Efficiënt: alleen items voor orders in de geselecteerde periode ophalen
  // NIET alle order_items voor alle stores (dat schaalt niet voor SaaS)
  const orderIds = (orders || []).map(o => o.id);
  let filteredItems = [];
  if (orderIds.length > 0) {
    // Supabase .in() heeft een limiet van 1000 — splits bij grote datasets
    const chunks = [];
    for (let i = 0; i < orderIds.length; i += 500) chunks.push(orderIds.slice(i, i + 500));
    for (const chunk of chunks) {
      const { data: chunkItems } = await supabase
        .from('order_items')
        .select('product_title, product_ean, quantity, total_price, platform, store_id, order_id')
        .in('order_id', chunk)
        .eq('user_id', user.id);
      if (chunkItems) filteredItems = filteredItems.concat(chunkItems);
    }
  }

  // ── STATISTIEKEN ──────────────────────────────────────────
  const BTW = 1.21;
  const exBtw = (b) => b / BTW;
  const totalBestellingen = (orders || []).length;
  const totalOmzet = (orders || []).reduce((sum, o) => sum + exBtw(o.total_amount || 0), 0);
  const gemOmzet = totalBestellingen > 0 ? totalOmzet / totalBestellingen : 0;

  // Top producten
  const productMap = {};
  filteredItems.forEach(item => {
    const key = item.product_ean || item.product_title || 'unknown';
    if (!productMap[key]) {
      productMap[key] = { titel: item.product_title || 'Onbekend', ean: item.product_ean, stuks: 0, omzet: 0 };
    }
    productMap[key].stuks += item.quantity || 1;
    productMap[key].omzet += exBtw(item.total_price || 0);
  });

  // Per dag omzet
  const dagMap = {};
  (orders || []).forEach(o => {
    const dag = o.order_date;
    if (!dagMap[dag]) dagMap[dag] = { datum: dag, bestellingen: 0, omzet: 0 };
    dagMap[dag].bestellingen++;
    dagMap[dag].omzet += exBtw(o.total_amount || 0);
  });

  // Per platform breakdown (voor multi-platform view)
  const platformMap = {};
  (orders || []).forEach(o => {
    const p = o.platform || 'onbekend';
    if (!platformMap[p]) platformMap[p] = { platform: p, bestellingen: 0, omzet: 0 };
    platformMap[p].bestellingen++;
    platformMap[p].omzet += exBtw(o.total_amount || 0);
  });

  // Vullen alle dagen in de periode (ook dagen zonder omzet)
  const allDays = getAllDaysInRange(start, end);
  const perDag = allDays.map(dag => dagMap[dag] || { datum: dag, bestellingen: 0, omzet: 0 });

  // ── VERGELIJKPERIODE ────────────────────────────────────
  let vergelijking = null;
  if (compareMode < 2 && cmpStartStr && cmpEndStr) {
    const { data: cmpOrders } = await supabase
      .from('orders').select('id, order_date, total_amount, platform')
      .in('store_id', storeIds).eq('user_id', user.id)
      .gte('order_date', cmpStartStr).lte('order_date', cmpEndStr);

    // Efficiënt: alleen items voor vergelijkperiode orders
    const cmpOrderIds = (cmpOrders || []).map(o => o.id);
    let cmpFilteredItems = [];
    if (cmpOrderIds.length > 0) {
      const { data: cmpItems } = await supabase
        .from('order_items').select('product_title, product_ean, quantity, total_price, order_id')
        .in('order_id', cmpOrderIds).eq('user_id', user.id);
      cmpFilteredItems = cmpItems || [];
    }

    const cmpTotal = (cmpOrders || []).reduce((sum, o) => sum + exBtw(o.total_amount || 0), 0);
    const cmpCount = (cmpOrders || []).length;

    const cmpDagMap = {};
    (cmpOrders || []).forEach(o => {
      if (!cmpDagMap[o.order_date]) cmpDagMap[o.order_date] = { datum: o.order_date, bestellingen: 0, omzet: 0 };
      cmpDagMap[o.order_date].bestellingen++;
      cmpDagMap[o.order_date].omzet += exBtw(o.total_amount || 0);
    });

    vergelijking = {
      samenvatting: {
        totalBestellingen: cmpCount,
        totalOmzet: Math.round(cmpTotal * 100) / 100,
        gemOmzetPerBestelling: cmpCount > 0 ? Math.round(cmpTotal / cmpCount * 100) / 100 : 0,
        periode: { start: cmpStartStr, end: cmpEndStr }
      },
      perDag: getAllDaysInRange(start, end).map((_, i) => {
        const cmpDag = getAllDaysInRange(cmpStartStr, cmpEndStr)[i];
        return cmpDag ? (cmpDagMap[cmpDag] || { datum: cmpDag, bestellingen: 0, omzet: 0 }) : { datum: '', bestellingen: 0, omzet: 0 };
      })
    };
  }

  return res.status(200).json({
    samenvatting: {
      totalBestellingen,
      totalOmzet: Math.round(totalOmzet * 100) / 100,
      gemOmzetPerBestelling: Math.round(gemOmzet * 100) / 100,
      periode: { start, end }
    },
    topProducten: Object.values(productMap).sort((a, b) => b.omzet - a.omzet).slice(0, 10),
    perDag,
    perPlatform: Object.values(platformMap),
    stores,
    vergelijking,
    opgehaaldUitDatabase: true,
    opgehaaldOp: new Date().toISOString(),
    _debug: { start, end, storeIds, totalOrdersFound: (orders || []).length }
  });
}

function getAllDaysInRange(start, end) {
  const days = [];
  const cur = new Date(start);
  const endDate = new Date(end);
  while (cur <= endDate) {
    days.push(cur.toISOString().split('T')[0]);
    cur.setDate(cur.getDate() + 1);
  }
  return days;
}
