// api/campaigns.js — bol.com Advertiser API
// Versie via Accept header, niet in URL pad

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

  // Versie zit in Accept header, niet in URL
  const ACCEPT_VERSIONS = [
    'application/vnd.advertiser.v11+json',
    'application/vnd.advertiser.v10+json',
    'application/vnd.advertiser.v9+json',
    'application/json',
  ];

  const BASE = 'https://api.bol.com/advertiser/sponsored-products';

  let lastStatus = null;
  let lastBody = null;

  for (const accept of ACCEPT_VERSIONS) {
    try {
      const campsRes = await fetch(`${BASE}/campaigns`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': accept
        }
      });

      lastStatus = campsRes.status;
      lastBody = await campsRes.text();

      if (!campsRes.ok) continue; // probeer volgende versie

      let campsData;
      try { campsData = JSON.parse(lastBody); } catch { continue; }

      let campaigns = Array.isArray(campsData) ? campsData
        : campsData.campaigns || campsData.content || campsData.items || campsData.data || [];

      if (!campaigns.length) {
        for (const key of Object.keys(campsData)) {
          if (Array.isArray(campsData[key]) && campsData[key].length > 0) {
            campaigns = campsData[key]; break;
          }
        }
      }

      if (!campaigns.length) {
        return res.status(200).json({
          campagnes: [], periode: { start, end }, totaal: 0,
          bericht: 'Geen campagnes gevonden', apiVersion: accept
        });
      }

      // Performance ophalen per campagne
      const enriched = await Promise.all(campaigns.map(async (camp) => {
        const campId = String(camp.campaignId || camp.id || '');
        const campName = camp.campaignName || camp.name || `Campagne ${campId}`;
        let p = {};

        if (campId) {
          try {
            // Probeer performance endpoint
            const perfRes = await fetch(
              `${BASE}/campaigns/${campId}/performance?startDate=${start}&endDate=${end}`,
              { headers: { 'Authorization': `Bearer ${token}`, 'Accept': accept } }
            );
            if (perfRes.ok) {
              p = await perfRes.json();
            }
          } catch {}
        }

        return {
          naam: campName,
          id: campId,
          status: camp.status || camp.state || camp.campaignStatus || 'UNKNOWN',
          vertoningen: p.impressions || 0,
          kliks: p.clicks || 0,
          bestellingen: p.conversions14d || p.conversions || p.orders || 0,
          kosten: p.spend || p.cost || p.costs || 0,
          omzet: p.sales14d || p.sales || p.revenue || 0,
          directConv: p.directConversions14d || 0,
          indirectConv: p.indirectConversions14d || 0,
          periode: { start, end }
        };
      }));

      return res.status(200).json({
        campagnes: enriched,
        periode: { start, end },
        totaal: enriched.length,
        apiVersion: accept,
        opgehaaldOp: new Date().toISOString()
      });

    } catch (err) {
      lastBody = err.message;
      continue;
    }
  }

  // Alle versies mislukt
  return res.status(lastStatus || 502).json({
    error: `Campagnes ophalen mislukt (${lastStatus})`,
    detail: lastBody ? lastBody.substring(0, 200) : 'Onbekende fout',
    hint: lastStatus === 403
      ? 'Je account is mogelijk nog niet gemigreerd naar het nieuwe Advertiser platform. Neem contact op met bol.com support.'
      : `HTTP ${lastStatus}`
  });
}
