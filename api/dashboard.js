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
  const { data: items } = await supabase
    .from('order_items')
    .select('product_title, product_ean, quantity, total_price, platform, store_id, order_id')
    .in('store_id', storeIds)
    .eq('user_id', user.id);

  // Filter items op order_id om alleen items in de periode mee te nemen
  const orderIds = new Set((orders || []).map(o => o.id));
  const filteredItems = (items || []).filter(i => orderIds.has(i.order_id));

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
    opgehaaldUitDatabase: true,
    opgehaaldOp: new Date().toISOString()
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
