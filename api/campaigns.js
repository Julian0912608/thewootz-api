// api/campaigns.js — bol.com Advertiser API v11

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(200).end();
  }
  res.setHeader('Access-Control-Allow-Origin', '*');

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Geen geldig Bearer token meegegeven' });
  }

  const token = authHeader.split(' ')[1];
  const { startDate, endDate } = req.query;
  const end   = endDate   || new Date().toISOString().split('T')[0];
  const start = startDate || new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];

  const BASE = 'https://api.bol.com/advertiser/sponsored-products/v11';
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/json'
  };

  try {
    const campsRes = await fetch(`${BASE}/campaigns`, { headers });

    if (!campsRes.ok) {
      const errBody = await campsRes.text();
      return res.status(campsRes.status).json({
        error: `Campagnes ophalen mislukt (${campsRes.status})`,
        detail: errBody.substring(0, 300),
        hint: campsRes.status === 403
          ? 'Maak aparte Advertiser API credentials aan via bol.com Partnerplatform → Adverteren → API toegang.'
          : 'Controleer je token'
      });
    }

    const campsData = await campsRes.json();
    let campaigns = Array.isArray(campsData) ? campsData
      : campsData.campaigns || campsData.content || campsData.items || [];

    if (!campaigns.length) {
      for (const key of Object.keys(campsData)) {
        if (Array.isArray(campsData[key])) { campaigns = campsData[key]; break; }
      }
    }

    if (!campaigns.length) {
      return res.status(200).json({ campagnes: [], periode: { start, end }, totaal: 0 });
    }

    const enriched = await Promise.all(campaigns.map(async (camp) => {
      const campId = camp.campaignId || camp.id || '';
      const campName = camp.campaignName || camp.name || `Campagne ${campId}`;
      let p = {};
      if (campId) {
        try {
          const perfRes = await fetch(
            `${BASE}/campaigns/${campId}/performance?startDate=${start}&endDate=${end}`,
            { headers }
          );
          if (perfRes.ok) p = await perfRes.json();
        } catch {}
      }
      return {
        naam: campName,
        id: String(campId),
        status: camp.status || 'UNKNOWN',
        vertoningen: p.impressions || 0,
        kliks: p.clicks || 0,
        bestellingen: p.conversions || p.conversions14d || p.orders || 0,
        kosten: p.spend || p.cost || 0,
        omzet: p.revenue || p.sales || p.sales14d || 0,
        periode: { start, end }
      };
    }));

    return res.status(200).json({
      campagnes: enriched,
      periode: { start, end },
      totaal: enriched.length,
      opgehaaldOp: new Date().toISOString()
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
