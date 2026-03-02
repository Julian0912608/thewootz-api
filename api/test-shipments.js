// api/test-shipments.js — Test shipments API direct zonder iets op te slaan
// Gebruik: GET /api/test-shipments?page=1

import { setCors, getSupabase, getUser } from './_lib/supabase.js';

const BASE = 'https://api.bol.com/retailer';

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: 'Niet ingelogd' });

  const supabase = getSupabase();
  const { data: stores } = await supabase
    .from('stores').select('*').eq('user_id', user.id).eq('platform', 'bol').limit(1);
  const store = stores?.[0];
  if (!store) return res.status(404).json({ error: 'Geen bol winkel gevonden' });

  const clientId     = Buffer.from(store.client_id_enc,     'base64').toString('utf8');
  const clientSecret = Buffer.from(store.client_secret_enc, 'base64').toString('utf8');

  // Token ophalen
  const creds = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const tokenR = await fetch('https://login.bol.com/token?grant_type=client_credentials', {
    method: 'POST',
    headers: { 'Authorization': `Basic ${creds}`, 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }
  });
  if (!tokenR.ok) return res.status(401).json({ error: 'Token mislukt', status: tokenR.status });
  const { access_token } = await tokenR.json();

  const page = parseInt(req.query.page || '1');
  const headers = { 'Authorization': `Bearer ${access_token}`, 'Accept': 'application/vnd.retailer.v10+json' };

  // Haal shipments op
  const shipR = await fetch(`${BASE}/shipments?page=${page}`, { headers });
  if (!shipR.ok) {
    const err = await shipR.text();
    return res.status(shipR.status).json({ error: `Shipments API fout (${shipR.status})`, detail: err.substring(0, 500) });
  }

  const data = await shipR.json();
  const shipments = data.shipments || [];

  // Toon de datums die we zouden opslaan
  const orderDates = shipments.map(s => ({
    orderId:   s.orderId,
    shipDate:  s.shipmentDate?.substring(0, 10),
    orderDate: s.order?.orderPlacedDateTime?.substring(0, 10) || s.orderPlacedDateTime?.substring(0, 10) || '(niet beschikbaar)',
    itemCount: (s.shipmentItems || []).length
  }));

  return res.status(200).json({
    page,
    shipmentsOpPagina: shipments.length,
    heeftMeerPaginas: shipments.length >= 50,
    orders: orderDates,
    // Vroegste en laatste datum op deze pagina
    vroegste: orderDates.map(o => o.orderDate).filter(d => d !== '(niet beschikbaar)').sort()[0] || '?',
    laatste:  orderDates.map(o => o.orderDate).filter(d => d !== '(niet beschikbaar)').sort().reverse()[0] || '?',
  });
}
