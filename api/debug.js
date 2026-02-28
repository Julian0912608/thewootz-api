export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { clientId, clientSecret } = req.body;
  const creds = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  // Token ophalen
  let token = null;
  const tokenRes = await fetch('https://login.bol.com/token?grant_type=client_credentials', {
    method: 'POST',
    headers: { 'Authorization': `Basic ${creds}`, 'Accept': 'application/json' }
  });
  const tokenData = await tokenRes.json();
  token = tokenData.access_token;

  if (!token) return res.status(200).json({ error: 'Token mislukt', detail: tokenData });

  // Test de juiste URL met Accept header versioning
  const tests = [
    { url: 'https://api.bol.com/advertiser/sponsored-products/campaigns', accept: 'application/vnd.advertiser.v11+json' },
    { url: 'https://api.bol.com/advertiser/sponsored-products/campaigns', accept: 'application/vnd.advertiser.v10+json' },
    { url: 'https://api.bol.com/advertiser/sponsored-products/campaigns', accept: 'application/vnd.advertiser.v9+json' },
    { url: 'https://api.bol.com/advertiser/sponsored-products/campaigns', accept: 'application/json' },
  ];

  const results = { scope: tokenData.scope, endpoints: {} };

  for (const t of tests) {
    const r = await fetch(t.url, {
      headers: { 'Authorization': `Bearer ${token}`, 'Accept': t.accept }
    });
    const body = await r.text();
    results.endpoints[t.accept] = { status: r.status, body: body.substring(0, 300) };
  }

  return res.status(200).json(results);
}
