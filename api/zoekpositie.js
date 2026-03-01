// api/zoekpositie.js — Zoekpositie via bol.com retailer API
// Gebruikt /products endpoint om EAN op te zoeken en positie te bepalen

import { setCors, getSupabase, getUser } from './_lib/supabase.js';

const BASE = 'https://api.bol.com/retailer';

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: 'Niet ingelogd' });

  const { term, storeId } = req.query;
  if (!term) return res.status(400).json({ error: 'term parameter verplicht' });

  const supabase = getSupabase();

  // Haal store op (eerste actieve bol.com store)
  const query = supabase.from('stores').select('*').eq('user_id', user.id).eq('platform', 'bol').eq('is_active', true);
  const { data: stores } = storeId ? await query.eq('id', storeId) : await query.limit(1);
  const store = stores?.[0];

  if (!store) return res.status(404).json({ error: 'Geen bol.com winkel gevonden. Koppel eerst een winkel.' });

  const clientId     = Buffer.from(store.client_id_enc,     'base64').toString('utf8');
  const clientSecret = Buffer.from(store.client_secret_enc, 'base64').toString('utf8');
  const token        = await getBolToken(clientId, clientSecret);
  if (!token) return res.status(401).json({ error: 'Bol.com authenticatie mislukt' });

  const headers = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.retailer.v10+json'
  };

  const isEan = /^\d{8,14}$/.test(term.replace(/\s/g, ''));

  if (isEan) {
    // EAN → zoek via products endpoint
    const ean = term.replace(/\s/g, '');
    const r = await fetch(`${BASE}/products/${ean}`, { headers });

    if (!r.ok) {
      return res.status(200).json({
        positie: null,
        ean,
        error: r.status === 404 ? `EAN ${ean} niet gevonden in bol.com catalogus.` : `Bol.com API fout (${r.status})`,
        tip: 'Controleer of het EAN juist is en het product op bol.com staat.'
      });
    }

    const product = await r.json();

    // Zoek rankings op
    const rankR = await fetch(`${BASE}/products/${ean}/assets?usage=MAIN`, { headers });
    const rankData = rankR.ok ? await rankR.json() : null;

    // Haal bestverkoperlijst op voor categorie vergelijking
    const offerR = await fetch(`${BASE}/offers?ean=${ean}`, { headers });
    const offerData = offerR.ok ? await offerR.json() : null;
    const offers = offerData?.offers || [];
    const eigenOffer = offers.find(o => o.mine === true);

    return res.status(200).json({
      ean,
      titel: product.title || product.productTitle || `Product ${ean}`,
      positie: eigenOffer?.ranking || null,
      aantalAanbieders: offers.length,
      eigenPrijs: eigenOffer?.pricing?.bundlePrices?.[0]?.price || eigenOffer?.price || null,
      laagstePrijs: offers[0]?.pricing?.bundlePrices?.[0]?.price || null,
      product: {
        categorie: product.mainCategory || product.category,
        rating: product.rating,
        reviewCount: product.reviewCount
      },
      tip: eigenOffer
        ? `Jouw aanbod staat op positie ${eigenOffer.ranking || '?'} van ${offers.length} aanbieders.`
        : `Product gevonden maar geen eigen aanbod actief voor EAN ${ean}.`
    });
  }

  // Zoekterm → gebruik offers zoek
  const r = await fetch(`${BASE}/offers?search=${encodeURIComponent(term)}&limit=10`, { headers });

  if (!r.ok) {
    // Fallback: zoek via product catalogus
    const catR = await fetch(`${BASE}/products?search=${encodeURIComponent(term)}&limit=5`, { headers });
    if (!catR.ok) {
      return res.status(200).json({
        positie: null,
        term,
        error: 'Zoekterm niet gevonden via bol.com API.',
        tip: 'Gebruik een EAN (barcode) voor nauwkeurigere resultaten.'
      });
    }
    const catData = await catR.json();
    const producten = catData.products || catData.items || [];
    return res.status(200).json({
      term,
      positie: null,
      resultaten: producten.slice(0, 5).map((p, i) => ({
        positie: i + 1,
        ean: p.ean,
        titel: p.title || p.productTitle,
        tip: `Gebruik EAN ${p.ean} voor exacte positiebepaling`
      })),
      tip: 'Zoekterm gevonden. Gebruik het EAN voor exacte rangschikking.'
    });
  }

  const data   = await r.json();
  const offers = data.offers || [];
  const eigen  = offers.find(o => o.mine === true);
  const positie = eigen ? offers.indexOf(eigen) + 1 : null;

  return res.status(200).json({
    term,
    positie,
    aantalResultaten: offers.length,
    eigenAanbod: eigen ? {
      ean: eigen.ean,
      prijs: eigen.pricing?.bundlePrices?.[0]?.price,
      ranking: eigen.ranking
    } : null,
    tip: eigen
      ? `Jouw product staat op positie ${positie} voor "${term}".`
      : `Geen eigen aanbod gevonden voor "${term}". Gebruik een EAN voor exacte resultaten.`
  });
}

async function getBolToken(clientId, clientSecret) {
  try {
    const creds = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const r = await fetch('https://login.bol.com/token?grant_type=client_credentials', {
      method: 'POST',
      headers: { 'Authorization': `Basic ${creds}`, 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    if (!r.ok) return null;
    return (await r.json()).access_token;
  } catch { return null; }
}
