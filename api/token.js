// api/token.js
// Veilige OAuth2 token-uitwisseling met bol.com
// Client secret blijft op de server — nooit in de browser

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

  // Credentials komen uit Vercel Environment Variables (nooit hardcoded)
  const clientId     = process.env.BOL_CLIENT_ID;
  const clientSecret = process.env.BOL_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return res.status(500).json({
      error: 'Server niet geconfigureerd',
      hint: 'Voeg BOL_CLIENT_ID en BOL_CLIENT_SECRET toe als Vercel Environment Variables'
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
      console.error('Bol.com token error:', tokenRes.status, errText);
      return res.status(tokenRes.status).json({
        error: 'Token ophalen mislukt',
        status: tokenRes.status,
        detail: tokenRes.status === 401 ? 'Ongeldige client_id of client_secret' : errText
      });
    }

    const tokenData = await tokenRes.json();

    // Stuur token terug naar frontend (access_token is tijdelijk, geen secret)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store');
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
