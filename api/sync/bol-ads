// api/sync/bol-ads.js — Bol.com Advertising API
// Haalt campagne data op: uitgaven, klikken, vertoningen, bestellingen, omzet

import { setCors, getSupabase, getUser } from '../_lib/supabase.js';

const ADS_BASE  = 'https://api.bol.com/retailer/advertiser';
const ADS_TOKEN = 'https://login.bol.com/token?grant_type=client_credentials';

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: 'Niet ingelogd' });

  const supabase = getSupabase();

  // ── GET: haal ads data op voor dashboard ─────────────────
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
    if (!token) return res.status(401).json({ error: 'Advertising API authenticatie mislukt. Controleer je credentials.' });

    const headers = { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.advertiser.v5+json' };

    const end   = endDate   || new Date().toISOString().split('T')[0];
    const start = startDate || new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];

    // Haal campagnes op
    const campR = await fetch(`${ADS_BASE}/campaigns?status=ACTIVE,PAUSED&page=1`, { headers });
    if (!campR.ok) {
      const err = await campR.text();
      return res.status(campR.status).json({ error: `Campaigns API fout (${campR.status})`, detail: err.substring(0, 300) });
    }
    const campData  = await campR.json();
    const campaigns = campData.campaigns || campData.items || [];

    // Haal performance per campagne op
    const perfR = await fetch(`${ADS_BASE}/performance/campaigns?startDate=${start}&endDate=${end}`, { headers });
    const perfData = perfR.ok ? await perfR.json() : { items: [] };
    const perfItems = perfData.items || perfData.campaignPerformances || [];

    // Haal ad group / product level performance op
    const prodR = await fetch(`${ADS_BASE}/performance/products?startDate=${start}&endDate=${end}&limit=50`, { headers });
    const prodData = prodR.ok ? await prodR.json() : { items: [] };
    const prodItems = prodData.items || prodData.productPerformances || [];

    return res.status(200).json({
      campaigns,
      performance: perfItems,
      products: prodItems,
      periode: { start, end }
    });
  }

  // ── POST: sla ads credentials op ─────────────────────────
  if (req.method === 'POST') {
    const { storeId, adsClientId, adsClientSecret } = req.body || {};
    if (!storeId || !adsClientId || !adsClientSecret) {
      return res.status(400).json({ error: 'storeId, adsClientId en adsClientSecret zijn verplicht' });
    }

    // Verifieer dat store van deze user is
    const { data: store } = await supabase.from('stores').select('id').eq('id', storeId).eq('user_id', user.id).single();
    if (!store) return res.status(404).json({ error: 'Store niet gevonden' });

    // Test credentials
    const token = await getAdsToken(adsClientId, adsClientSecret);
    if (!token) return res.status(401).json({ error: 'Ongeldige advertising credentials. Controleer je Client ID en Secret.' });

    // Sla op (base64 encoded)
    const { error } = await supabase.from('stores').update({
      ads_client_id_enc:     Buffer.from(adsClientId).toString('base64'),
      ads_client_secret_enc: Buffer.from(adsClientSecret).toString('base64')
    }).eq('id', storeId);

    if (error) return res.status(500).json({ error: 'Opslaan mislukt: ' + error.message });

    return res.status(200).json({ message: 'Advertising credentials opgeslagen en geverifieerd!' });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

async function getAdsToken(clientId, clientSecret) {
  try {
    const creds = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const r = await fetch(ADS_TOKEN, {
      method: 'POST',
      headers: { 'Authorization': `Basic ${creds}`, 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    if (!r.ok) return null;
    return (await r.json()).access_token;
  } catch { return null; }
}
