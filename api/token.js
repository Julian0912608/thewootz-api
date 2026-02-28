// api/token.js
// OAuth2 token uitwisseling — credentials komen uit de request body
// Zodat elke gebruiker zijn eigen bol.com API credentials kan gebruiken

export default async function handler(req, res) {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  res.setHeader('Access-Control-Allow-Origin', '*');

  // Credentials komen uit de request body (ingevuld door de gebruiker)
  const { clientId, clientSecret } = req.body || {};

  if (!clientId || !clientSecret) {
    return res.status(400).json({
      error: 'Client ID en Client Secret zijn verplicht'
    });
  }

  try {
    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

    const tokenRes = await fetch('https://login.bol.com/token?grant_type=client_credentials', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      return res.status(tokenRes.status).json({
        error: 'Bol.com authenticatie mislukt',
        detail: tokenRes.status === 401
          ? 'Ongeldige Client ID of Client Secret — controleer je gegevens in het bol.com Partnerplatform'
          : errText
      });
    }

    const tokenData = await tokenRes.json();

    return res.status(200).json({
      access_token: tokenData.access_token,
      expires_in: tokenData.expires_in || 300,
      token_type: tokenData.token_type || 'Bearer'
    });

  } catch (err) {
    console.error('Token handler error:', err);
    return res.status(500).json({ error: 'Interne serverfout', detail: err.message });
  }
}
