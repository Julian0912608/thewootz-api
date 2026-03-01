// api/zoekpositie.js — Aanbiedingen checker via bol.com retailer API
// Haalt jouw eigen actieve aanbiedingen op en toont prijs + voorraad + status

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
  const query = supabase.from('stores').select('*').eq('user_id', user.id).eq('platform', 'bol').eq('is_active', true);
  const { data: stores } = storeId ? await query.eq('id', storeId).limit(1) : await query.limit(1);
  const store = stores?.[0];
  if (!store) return res.status(404).json({ error: 'Geen bol.com winkel gevonden.' });

  const clientId     = Buffer.from(store.client_id_enc,     'base64').toString('utf8');
  const clientSecret = Buffer.from(store.client_secret_enc, 'base64').toString('utf8');
  const token        = await getBolToken(clientId, clientSecret);
  if (!token) return res.status(401).json({ error: 'Bol.com authenticatie mislukt' });

  const headers = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.retailer.v10+json'
  };

  // Haal alle eigen aanbiedingen op en filter op EAN of titel
  const isEan = /^\d{8,14}$/.test(term.replace(/\s/g, ''));

  // Zoek via offers endpoint
  let url = `${BASE}/offers?status=ACTIVE&limit=50`;
  if (isEan) url += `&ean=${term.replace(/\s/g, '')}`;

  const r = await fetch(url, { headers });

  if (!r.ok) {
    const err = await r.text();
    return res.status(200).json({
      positie: null, term,
      error: `Bol.com API fout (${r.status})`,
      detail: err.substring(0, 200)
    });
  }

  const data   = await r.json();
  const offers = data.offers || [];

  // Filter op zoekterm als het geen EAN is
  const filtered = isEan
    ? offers
    : offers.filter(o =>
        o.ean?.includes(term) ||
        o.reference?.toLowerCase().includes(term.toLowerCase())
      );

  if (!filtered.length) {
    // Probeer via order_items in onze database te zoeken
    const { data: items } = await supabase
      .from('order_items')
      .select('product_title, product_ean, quantity, unit_price')
      .eq('user_id', user.id)
      .ilike('product_ean', `%${term}%`)
      .limit(5);

    if (items?.length) {
      const item = items[0];
      return res.status(200).json({
        ean: item.product_ean,
        titel: item.product_title,
        positie: null,
        bron: 'database',
        verkochtStuks: items.reduce((s,i) => s + i.quantity, 0),
        tip: `EAN ${item.product_ean} gevonden in verkoophistorie. Dit product heeft ${items.reduce((s,i) => s + i.quantity, 0)} stuks verkocht. Zoekpositie is niet beschikbaar via de API.`
      });
    }

    return res.status(200).json({
      positie: null, term,
      melding: isEan
        ? `EAN ${term} heeft geen actief aanbod in jouw winkel.`
        : `Geen actief aanbod gevonden voor "${term}".`,
      tip: 'Controleer of het product actief staat in je bol.com verkopersportaal.'
    });
  }

  // Geef aanbod info terug
  const offer = filtered[0];
  return res.status(200).json({
    ean: offer.ean,
    titel: offer.reference || offer.ean,
    positie: null, // niet beschikbaar via retailer API
    prijs: offer.pricing?.bundlePrices?.[0]?.price || null,
    voorraad: offer.stock?.amount || 0,
    status: offer.status || 'ACTIVE',
    fulfillment: offer.fulfilment?.method || 'FBR',
    aantalGevonden: filtered.length,
    tip: `Aanbod actief voor EAN ${offer.ean}. Prijs: €${offer.pricing?.bundlePrices?.[0]?.price || '?'}. Voorraad: ${offer.stock?.amount || 0} stuks.\n\n⚠️ Zoekpositie (rang in zoekresultaten) is niet beschikbaar via de bol.com API — bekijk dit in je Partnerplatform onder "Zichtbaarheid".`
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
