// api/debug.js
// Tijdelijk debug endpoint — verwijder na gebruik

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { clientId, clientSecret } = req.body;
  if (!clientId || !clientSecret) return res.status(400).json({ error: 'clientId en clientSecret vereist' });

  const results = {};

  // Stap 1: token ophalen
  let token = null;
  try {
    const creds = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const tokenRes = await fetch('https://login.bol.com/token?grant_type=client_credentials', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${creds}`,
        'Accept': 'application/json'
      }
    });
    const tokenData = await tokenRes.json();
    results.token = {
      status: tokenRes.status,
      ok: tokenRes.ok,
      expires_in: tokenData.expires_in,
      token_type: tokenData.token_type,
      hasToken: !!tokenData.access_token
    };
    token = tokenData.access_token;
  } catch (e) {
    results.token = { error: e.message };
  }

  if (!token) return res.status(200).json({ results, error: 'Token ophalen mislukt' });

  // Stap 2: test verschillende adverteer endpoints
  const endpoints = [
    'https://api.bol.com/retailer/advertiser/v10/sponsored-products/campaigns',
    'https://api.bol.com/advertiser/v10/sponsored-products/campaigns',
    'https://api.bol.com/retailer/advertiser/v9/sponsored-products/campaigns',
    'https://api.bol.com/advertiser/v9/sponsored-products/campaigns',
    'https://api.bol.com/retailer/advertiser/campaigns',
    'https://api.bol.com/retailer/advertiser/v10/campaigns',
  ];

  results.endpoints = {};

  for (const url of endpoints) {
    try {
      const r = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/json'
        }
      });
      let body = '';
      try { body = await r.text(); } catch {}
      results.endpoints[url] = {
        status: r.status,
        ok: r.ok,
        body: body.substring(0, 300)
      };
    } catch (e) {
      results.endpoints[url] = { error: e.message };
    }
  }

  return res.status(200).json(results);
}
