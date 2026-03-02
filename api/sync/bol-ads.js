// api/sync/bol-ads.js — Bol.com Advertising API v11
// Werkende endpoints:
//   GET /advertiser/sponsored-products/reporting/performance/advertiser  → totalen
//   GET /advertiser/sponsored-products/reporting/performance/advertiser/search-terms → zoektermen
//   GET /advertiser/sponsored-products/reporting/performance/advertiser/categories → categorieën

import { setCors, getSupabase, getUser } from '../_lib/supabase.js';

const TOKEN_URL = 'https://login.bol.com/token?grant_type=client_credentials';
const BASE      = 'https://api.bol.com/advertiser/sponsored-products/reporting/performance';

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: 'Niet ingelogd' });

  const supabase = getSupabase();

  // ── POST: sla ads credentials op ─────────────────────────
  if (req.method === 'POST') {
    const { storeId, adsClientId, adsClientSecret } = req.body || {};
    if (!storeId || !adsClientId || !adsClientSecret)
      return res.status(400).json({ error: 'storeId, adsClientId en adsClientSecret zijn verplicht' });

    const { data: store } = await supabase.from('stores').select('id').eq('id', storeId).eq('user_id', user.id).single();
    if (!store) return res.status(404).json({ error: 'Store niet gevonden' });

    const token = await getAdsToken(adsClientId, adsClientSecret);
    if (!token) return res.status(401).json({ error: 'Ongeldige credentials — token aanmaken mislukt.' });

    const { error } = await supabase.from('stores').update({
      ads_client_id_enc:     Buffer.from(adsClientId).toString('base64'),
      ads_client_secret_enc: Buffer.from(adsClientSecret).toString('base64')
    }).eq('id', storeId);

    if (error) return res.status(500).json({ error: 'Opslaan mislukt: ' + error.message });
    return res.status(200).json({ message: 'Advertising credentials opgeslagen!' });
  }

  // ── GET: haal ads performance op ─────────────────────────
  if (req.method === 'GET') {
    const { storeId, startDate, endDate } = req.query;

    const query = supabase.from('stores').select('*').eq('user_id', user.id).eq('platform', 'bol').eq('is_active', true);
    const { data: stores } = storeId ? await query.eq('id', storeId).limit(1) : await query.limit(1);
    const store = stores?.[0];

    if (!store)                   return res.status(404).json({ error: 'Geen winkel gevonden' });
    if (!store.ads_client_id_enc) return res.status(404).json({ error: 'no_ads_credentials' });

    const adsClientId     = Buffer.from(store.ads_client_id_enc,     'base64').toString('utf8');
    const adsClientSecret = Buffer.from(store.ads_client_secret_enc, 'base64').toString('utf8');
    const token           = await getAdsToken(adsClientId, adsClientSecret);
    if (!token) return res.status(401).json({ error: 'Advertising API authenticatie mislukt.' });

    const end   = endDate   || new Date().toISOString().split('T')[0];
    const start = startDate || new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
    const params = `period-start-date=${start}&period-end-date=${end}`;

    const headers = {
      'Authorization': `Bearer ${token}`,
      'Accept':        'application/vnd.advertiser.v11+json',
      'Content-Type':  'application/vnd.advertiser.v11+json'
    };

    // Voer alle calls parallel uit
    const [totR, searchR, catR] = await Promise.all([
      fetch(`${BASE}/advertiser?${params}`,              { headers }),
      fetch(`${BASE}/advertiser/search-terms?${params}&page=1&page-size=20`, { headers }),
      fetch(`${BASE}/advertiser/categories?${params}&page=1&page-size=10`,   { headers }),
    ]);

    // Totalen (verplicht)
    if (!totR.ok) {
      return res.status(totR.status).json({ error: `Reporting API fout (${totR.status})` });
    }
    const totals = await totR.json();

    // Debug mode 2: toon ruwe API responses
    if (req.query.debug === '2') {
      return res.status(200).json({
        searchR: { status: searchR.status, body: searchR.ok ? await searchR.json() : await searchR.text() },
        catR:    { status: catR.status,    body: catR.ok    ? await catR.json()    : await catR.text()    },
      });
    }

    // Zoektermen (optioneel)
    let searchTerms = [];
    if (searchR.ok) {
      const sd = await searchR.json();
      // Probeer alle mogelijke veldnamen
      searchTerms = (sd.searchTermPerformances || sd.performances || sd.items || sd.results || [])
        .sort((a, b) => (b.clicks || 0) - (a.clicks || 0))
        .slice(0, 20);
    }

    // Categorieën (optioneel)
    let categories = [];
    if (catR.ok) {
      const cd = await catR.json();
      categories = (cd.categoryPerformances || cd.performances || cd.items || cd.results || [])
        .sort((a, b) => (b.impressions || 0) - (a.impressions || 0))
        .slice(0, 10);
    }

    // ── Per-dag breakdown (max 14 dagen, anders te veel API calls) ──
    const adGroupR = await fetch(`${BASE}/advertiser/search-terms?${params}&page=1&page-size=50`, { headers });
    let adGroupData = [];
    if (adGroupR.ok) {
      const agd = await adGroupR.json();
      adGroupData = agd.searchTermPerformances || agd.performances || agd.items || agd.results || [];
    }

    const dagData = [];
    const startDt = new Date(start);
    const endDt   = new Date(end);
    const diffDays = Math.round((endDt - startDt) / 86400000) + 1;

    // Alleen per-dag ophalen als periode ≤ 14 dagen (anders rate limit 400)
    if (diffDays <= 14) {
      // Sequentieel ipv parallel — voorkomt rate limit errors
      for (let i = 0; i < diffDays; i++) {
        const d = new Date(startDt);
        d.setDate(d.getDate() + i);
        const dag = d.toISOString().split('T')[0];
        try {
          const r = await fetch(`${BASE}/advertiser?period-start-date=${dag}&period-end-date=${dag}`, { headers });
          if (r.ok) {
            const j = await r.json();
            dagData.push({ datum: dag, ...j });
          } else {
            dagData.push({ datum: dag, cost: 0, clicks: 0, impressions: 0, conversions14d: 0, sales14d: 0 });
          }
        } catch {
          dagData.push({ datum: dag, cost: 0, clicks: 0, impressions: 0, conversions14d: 0, sales14d: 0 });
        }
      }
    } else {
      // Bij langere periodes: verdeel in weken en haal per week op (7 calls max)
      const weeks = Math.ceil(diffDays / 7);
      for (let w = 0; w < Math.min(weeks, 8); w++) {
        const wStart = new Date(startDt);
        wStart.setDate(wStart.getDate() + w * 7);
        const wEnd = new Date(wStart);
        wEnd.setDate(wEnd.getDate() + 6);
        if (wEnd > endDt) wEnd.setTime(endDt.getTime());
        const ws = wStart.toISOString().split('T')[0];
        const we = wEnd.toISOString().split('T')[0];
        try {
          const r = await fetch(`${BASE}/advertiser?period-start-date=${ws}&period-end-date=${we}`, { headers });
          if (r.ok) {
            const j = await r.json();
            // Maak 7 dag-entries aan met gelijkmatig verdeelde waarden
            const days = Math.round((wEnd - wStart) / 86400000) + 1;
            for (let d = 0; d < days; d++) {
              const dayDt = new Date(wStart);
              dayDt.setDate(dayDt.getDate() + d);
              dagData.push({
                datum: dayDt.toISOString().split('T')[0],
                cost:        (j.cost        || 0) / days,
                clicks:      Math.round((j.clicks      || 0) / days),
                impressions: Math.round((j.impressions  || 0) / days),
                conversions14d: Math.round((j.conversions14d || 0) / days),
                sales14d:    (j.sales14d    || 0) / days,
              });
            }
          }
        } catch { /* skip */ }
      }
    }

    return res.status(200).json({
      searchTermsRaw: adGroupData.slice(0, 30),
      totals: {
        impressions:       totals.impressions          || 0,
        clicks:            totals.clicks               || 0,
        ctr:               totals.ctr                  || 0,
        conversions:       totals.conversions14d       || 0,
        directConversions: totals.directConversions14d || 0,
        conversionRate:    totals.conversionRate14d    || 0,
        averageCpc:        totals.averageCpc           || 0,
        sales:             totals.sales14d             || 0,
        cost:              totals.cost                 || 0,
        acos:              totals.acos14d              || 0,
        roas:              totals.roas14d              || 0,
        tacos:             totals.tacos                || null,
        averageWinningBid: totals.averageWinningBid    || 0,
      },
      searchTerms,
      categories,
      perDag: dagData,
      periode: { start, end, days: diffDays }
    });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

async function getAdsToken(clientId, clientSecret) {
  try {
    const creds = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const r = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Authorization': `Basic ${creds}`, 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    if (!r.ok) return null;
    return (await r.json()).access_token || null;
  } catch { return null; }
}
