// api/cron/sync-orders.js — Nachtelijke cron: sync alle actieve stores
// Draait elke nacht om 02:00 via Vercel Crons (zie vercel.json)
// Zo heeft iedereen altijd up-to-date data 's ochtends

export default async function handler(req, res) {
  // Vercel cron authenticatie
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { getSupabase } = await import('../_lib/supabase.js');
  const supabase = getSupabase();

  // Haal alle actieve bol.com stores op
  const { data: stores, error } = await supabase
    .from('stores')
    .select('id, user_id, platform')
    .eq('platform', 'bol')
    .eq('is_active', true);

  if (error) return res.status(500).json({ error: error.message });

  const results = [];
  const BASE_URL = process.env.VERCEL_URL 
    ? `https://${process.env.VERCEL_URL}` 
    : 'https://thewootz-api.vercel.app';

  for (const store of stores || []) {
    try {
      // Roep de sync endpoint aan voor elke store
      // We gebruiken een service token zodat getUser werkt in de sync endpoint
      const serviceToken = await getServiceToken(supabase, store.user_id);
      
      const syncRes = await fetch(`${BASE_URL}/api/sync/bol`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-User-Token': serviceToken
        },
        body: JSON.stringify({ storeId: store.id, fullSync: false })
      });
      
      const data = await syncRes.json();
      results.push({ storeId: store.id, ...data });
    } catch (e) {
      results.push({ storeId: store.id, error: e.message });
    }
  }

  return res.status(200).json({
    message: `Nachtelijke sync klaar voor ${stores?.length || 0} stores`,
    results,
    runAt: new Date().toISOString()
  });
}

// Haal een service token op voor een gebruiker (via admin API)
async function getServiceToken(supabase, userId) {
  const { data } = await supabase.auth.admin.getUserById(userId);
  // In productie: gebruik een kortstondig service token
  // Voor MVP: gebruik de user ID als identifier en valideer server-side
  return data?.user?.email || userId;
}
