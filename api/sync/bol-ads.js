// api/sync/bol-ads.js — Bol.com Advertising API v11
// Werkende endpoint: GET /advertiser/sponsored-products/reporting/performance/advertiser

import { setCors, getSupabase, getUser } from '../_lib/supabase.js';

const TOKEN_URL = 'https://login.bol.com/token?grant_type=client_credentials';
const REPORT_URL = 'https://api.bol.com/advertiser/sponsored-products/reporting/performance/advertiser';
const CAMP_REPORT_URL = 'https://api.bol.com/advertiser/sponsored-products/reporting/performance';

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

    // Test credentials door reporting endpoint te testen
    const token = await getAdsToken(adsClientId, adsClientSecret);
    if (!token) return res.status(401).json({ error: 'Ongeldige credentials — token aanmaken mislukt.' });

    const today = new Date().toISOString().split('T')[0];
    const testR = await fetch(`${REPORT_URL}?period-start-date=${today}&period-end-date=${today}`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.advertiser.v11+json'
      }
    });

    if (!testR.ok && testR.status === 401)
      return res.status(401).json({ error: 'Credentials geweigerd door bol.com Advertising API.' });

    // 403 of 200 = credentials werken, sla op
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

    if (!store)                 return res.status(404).json({ error: 'Geen winkel gevonden' });
    if (!store.ads_client_id_enc) return res.status(404).json({ error: 'no_ads_credentials' });

    const adsClientId     = Buffer.from(store.ads_client_id_enc,     'base64').toString('utf8');
    const adsClientSecret = Buffer.from(store.ads_client_secret_enc, 'base64').toString('utf8');
    const token           = await getAdsToken(adsClientId, adsClientSecret);
    if (!token) return res.status(401).json({ error: 'Advertising API authenticatie mislukt.' });

    const end   = endDate   || new Date().toISOString().split('T')[0];
    const start = startDate || new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];

    const headers = {
      'Authorization': `Bearer ${token}`,
      'Accept':        'application/vnd.advertiser.v11+json',
      'Content-Type':  'application/vnd.advertiser.v11+json'
    };

    // ── Advertiser totalen (werkt!) ───────────────────────────
    const totR = await fetch(`${REPORT_URL}?period-start-date=${start}&period-end-date=${end}`, { headers });
    if (!totR.ok) {
      return res.status(totR.status).json({ error: `Reporting API fout (${totR.status})`, detail: await totR.text() });
    }
    const totals = await totR.json();

    // ── Dagelijkse breakdown voor grafiek ────────────────────
    // Haal per dag op door kortere periodes te sturen (max 1 call)
    const days = [];
    const startDt = new Date(start);
    const endDt   = new Date(end);
    const diffDays = Math.round((endDt - startDt) / 86400000) + 1;

    // Bouw per-dag array op basis van totale periode
    // (bol.com advertiser endpoint geeft alleen totalen, geen dagelijkse breakdown)
    // We slaan totalen op en tonen ze als KPIs

    return res.status(200).json({
      totals: {
        impressions:          totals.impressions          || 0,
        clicks:               totals.clicks               || 0,
        ctr:                  totals.ctr                  || 0,
        conversions:          totals.conversions14d       || 0,
        directConversions:    totals.directConversions14d || 0,
        conversionRate:       totals.conversionRate14d    || 0,
        averageCpc:           totals.averageCpc           || 0,
        sales:                totals.sales14d             || 0,
        cost:                 totals.cost                 || 0,
        acos:                 totals.acos14d              || 0,
        roas:                 totals.roas14d              || 0,
        averageWinningBid:    totals.averageWinningBid    || 0,
      },
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
      headers: {
        'Authorization': `Basic ${creds}`,
        'Accept':        'application/json',
        'Content-Type':  'application/x-www-form-urlencoded'
      }
    });
    if (!r.ok) return null;
    return (await r.json()).access_token || null;
  } catch { return null; }
}
