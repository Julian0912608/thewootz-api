// api/sync/bol-ads.js — Bol.com Advertising API v11
// Base: https://api.bol.com/advertiser/
// Auth: zelfde token flow als retailer API maar met ads credentials
// Campaigns: PUT /sponsored-products/campaigns (filter endpoint)
// Reporting: GET /sponsored-products/reporting/performance/advertiser

import { setCors, getSupabase, getUser } from '../_lib/supabase.js';

const ADS_BASE  = 'https://api.bol.com/advertiser/sponsored-products';
const TOKEN_URL = 'https://login.bol.com/token?grant_type=client_credentials';

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

    // Test credentials
    const token = await getAdsToken(adsClientId, adsClientSecret);
    if (!token) return res.status(401).json({ error: 'Ongeldige advertising credentials. Controleer je Client ID en Secret.' });

    const { error } = await supabase.from('stores').update({
      ads_client_id_enc:     Buffer.from(adsClientId).toString('base64'),
      ads_client_secret_enc: Buffer.from(adsClientSecret).toString('base64')
    }).eq('id', storeId);

    if (error) return res.status(500).json({ error: 'Opslaan mislukt: ' + error.message });
    return res.status(200).json({ message: 'Advertising credentials opgeslagen en geverifieerd!' });
  }

  // ── GET: haal ads data op ─────────────────────────────────
  if (req.method === 'GET') {
    const { storeId, startDate, endDate } = req.query;

    const query = supabase.from('stores').select('*').eq('user_id', user.id).eq('platform', 'bol').eq('is_active', true);
    const { data: stores } = storeId ? await query.eq('id', storeId).limit(1) : await query.limit(1);
    const store = stores?.[0];

    if (!store) return res.status(404).json({ error: 'Geen winkel gevonden' });
    if (!store.ads_client_id_enc) return res.status(404).json({ error: 'no_ads_credentials', message: 'Geen advertising credentials gekoppeld.' });

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

    // ── Stap 0: Test met advertiser-info endpoint ────────────
    // Probeer eerst het eenvoudigste endpoint om te zien of token werkt
    const infoR = await fetch('https://api.bol.com/advertiser/account', { method: 'GET', headers });
    const infoR2 = await fetch('https://api.bol.com/advertiser/advertisers', { method: 'GET', headers });

    // Debug: probeer ook de reporting endpoint direct (geen campagne ID nodig)
    const reportR = await fetch(
      `https://api.bol.com/advertiser/sponsored-products/reporting/performance/advertiser?period-start-date=${start}&period-end-date=${end}`,
      { method: 'GET', headers }
    );

    // Als debug mode, return alle resultaten
    if (req.query.debug === '1') {
      return res.status(200).json({
        account:   { status: infoR.status,   body: infoR.ok   ? await infoR.json()   : await infoR.text()   },
        advertisers: { status: infoR2.status, body: infoR2.ok ? await infoR2.json()  : await infoR2.text()  },
        reporting: { status: reportR.status, body: reportR.ok ? await reportR.json() : await reportR.text() },
      });
    }

    // ── Stap 1: Haal campagnes op (PUT filter endpoint in v11) ─
    const campR = await fetch(`${ADS_BASE}/campaigns`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ page: 1, pageSize: 50 })
    });

    if (!campR.ok) {
      const err = await campR.text();
      return res.status(campR.status).json({
        error: `Campaigns API fout (${campR.status})`,
        detail: err.substring(0, 300),
        tip: campR.status === 403 ? 'Controleer of je Advertising API credentials de juiste scope hebben (adverteren).' : undefined
      });
    }

    const campData  = await campR.json();
    const campaigns = campData.campaigns || campData.items || [];

    // ── Stap 2: Advertiser-level performance report ───────────
    const perfR = await fetch(
      `${ADS_BASE}/reporting/performance/advertiser?period-start-date=${start}&period-end-date=${end}`,
      { method: 'GET', headers }
    );

    let totals = null;
    if (perfR.ok) {
      const perfData = await perfR.json();
      totals = perfData.total || perfData;
    }

    // ── Stap 3: Campaign-level performance ───────────────────
    let campPerf = [];
    if (campaigns.length) {
      const campIds = campaigns.slice(0, 20).map(c => c.campaignId);
      const cpR = await fetch(
        `${ADS_BASE}/reporting/performance?period-start-date=${start}&period-end-date=${end}`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ entityType: 'CAMPAIGN', entityIds: campIds })
        }
      );
      if (cpR.ok) {
        const cpData = await cpR.json();
        campPerf = cpData.items || cpData.performances || [];
      }
    }

    // Koppel campagne namen aan performance
    const campMap = {};
    campaigns.forEach(c => { campMap[c.campaignId] = c.name || c.campaignName || `Campagne ${c.campaignId}`; });

    const products = campPerf.map(p => ({
      naam:        campMap[p.entityId] || campMap[p.campaignId] || p.entityId || 'Campagne',
      spend:       p.cost  || p.spend  || 0,
      impressions: p.impressions || 0,
      clicks:      p.clicks || 0,
      orders:      p.conversions14d || p.directConversions14d || p.orders || 0,
      revenue:     p.sales14d || p.revenue || 0
    }));

    return res.status(200).json({
      campaigns,
      totals,
      products,
      periode: { start, end }
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
        'Authorization':  `Basic ${creds}`,
        'Accept':         'application/json',
        'Content-Type':   'application/x-www-form-urlencoded'
      }
    });
    if (!r.ok) return null;
    const data = await r.json();
    return data.access_token || null;
  } catch { return null; }
}
