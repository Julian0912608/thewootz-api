// api/debug.js — uitgebreide versie met scope check

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { clientId, clientSecret } = req.body;
  if (!clientId || !clientSecret) return res.status(400).json({ error: 'clientId en clientSecret vereist' });

  const creds = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const results = {};

  // Stap 1: token ophalen
  let token = null;
  try {
    const tokenRes = await fetch('https://login.bol.com/token?grant_type=client_credentials', {
      method: 'POST',
      headers: { 'Authorization': `Basic ${creds}`, 'Accept': 'application/json' }
    });
    const tokenData = await tokenRes.json();
    results.token = {
      status: tokenRes.status,
      ok: tokenRes.ok,
      expires_in: tokenData.expires_in,
      token_type: tokenData.token_type,
      scope: tokenData.scope,  // Dit laat zien welke rechten je hebt
      hasToken: !!tokenData.access_token
    };
    token = tokenData.access_token;
  } catch (e) {
    results.token = { error: e.message };
  }

  if (!token) return res.status(200).json({ results, error: 'Token ophalen mislukt' });

  // Stap 2: test alle mogelijke campaign endpoints
  const endpoints = [
    { url: 'https://api.bol.com/advertiser/sponsored-products/v11/campaigns', method: 'GET' },
    { url: 'https://api.bol.com/advertiser/sponsored-products/v11/campaigns', method: 'PUT', body: { page: 0, pageSize: 10 } },
    { url: 'https://api.bol.com/retailer/advertiser/v11/sponsored-products/campaigns', method: 'GET' },
    { url: 'https://api.bol.com/retailer/advertiser/v10/sponsored-products/campaigns', method: 'GET' },
    { url: 'https://api.bol.com/advertiser/v11/sponsored-products/campaigns', method: 'GET' },
  ];

  results.endpoints = {};
  for (const ep of endpoints) {
    try {
      const opts = {
        method: ep.method,
        headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json', 'Content-Type': 'application/json' }
      };
      if (ep.body) opts.body = JSON.stringify(ep.body);
      const r = await fetch(ep.url, opts);
      let body = '';
      try { body = await r.text(); } catch {}
      results.endpoints[`${ep.method} ${ep.url}`] = {
        status: r.status,
        ok: r.ok,
        body: body.substring(0, 200)
      };
    } catch (e) {
      results.endpoints[`${ep.method} ${ep.url}`] = { error: e.message };
    }
  }

  return res.status(200).json(results);
}
