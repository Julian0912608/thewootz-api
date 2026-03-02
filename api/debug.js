// api/debug.js — Tijdelijk diagnostisch endpoint
// Toont exact wat er in Supabase staat zodat we het probleem kunnen vinden

import { setCors, getSupabase, getUser } from './_lib/supabase.js';

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: 'Niet ingelogd' });

  const supabase = getSupabase();

  // Haal stores op
  const { data: stores } = await supabase
    .from('stores').select('id, name, platform, last_synced_at').eq('user_id', user.id);

  if (!stores?.length) return res.status(200).json({ stores: [], orders: [], message: 'Geen winkels gevonden' });

  const storeIds = stores.map(s => s.id);

  // Haal ALLE orders op (geen datumfilter)
  const { data: orders, error: ordErr } = await supabase
    .from('orders')
    .select('id, external_id, order_date, total_amount, status, created_at')
    .in('store_id', storeIds)
    .order('order_date', { ascending: false })
    .limit(200);

  // Groepeer per datum
  const perDatum = {};
  for (const o of (orders || [])) {
    const d = o.order_date;
    if (!perDatum[d]) perDatum[d] = 0;
    perDatum[d]++;
  }

  // Vroegste en laatste order
  const dates = Object.keys(perDatum).sort();

  return res.status(200).json({
    stores,
    totalOrders: (orders || []).length,
    vroegste: dates[0] || null,
    laatste: dates[dates.length - 1] || null,
    perDatum: Object.fromEntries(Object.entries(perDatum).slice(-30)), // laatste 30 datums
    eersteOrders: (orders || []).slice(0, 5).map(o => ({
      external_id: o.external_id,
      order_date: o.order_date,
      total_amount: o.total_amount,
      status: o.status,
      created_at: o.created_at
    })),
    supabaseError: ordErr?.message || null
  });
}
