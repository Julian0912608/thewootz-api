// api/campaigns.js
// Proxy naar bol.com Advertising API — campagne performance data

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

  // Probeer meerdere API versies (bol.com heeft v9 en v10)
  const API_VERSIONS = [
    'https://api.bol.com/retailer/advertiser/v10',
    'https://api.bol.com/advertiser/v10',
    'https://api.bol.com/retailer/advertiser/v9',
    'https://api.bol.com/advertiser/v9',
  ];

  const ACCEPT_HEADERS = [
    'application/vnd.retailer.advertiser.v10+json',
    'application/vnd.advertiser.v10+json',
    'application/vnd.retailer.advertiser.v9+json',
    'application/vnd.advertiser.v9+json',
    'application/json',
  ];

  let lastError = null;

  for (let i = 0; i < API_VERSIONS.length; i++) {
    const baseUrl = API_VERSIONS[i];
    const accept = ACCEPT_HEADERS[i] || 'application/json';

    try {
      // Stap 1: haal campagnes op
      const campsRes = await fetch(`${baseUrl}/sponsored-products/campaigns`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': accept,
          'Content-Type': 'application/json'
        }
      });

      if (!campsRes.ok) {
        lastError = `${baseUrl}: ${campsRes.status}`;
        continue; // probeer volgende versie
      }

      const campsData = await campsRes.json();

      // Flexibel omgaan met verschillende response structuren
      let campaigns = [];
      if (Array.isArray(campsData)) campaigns = campsData;
      else if (campsData.campaigns) campaigns = campsData.campaigns;
      else if (campsData.content) campaigns = campsData.content;
      else if (campsData.items) campaigns = campsData.items;
      else {
        // Log wat we terugkrijgen voor debugging
        console.log('Onverwachte campagne response structuur:', JSON.stringify(campsData).substring(0, 500));
        // Probeer alle keys te doorzoeken op arrays
        for (const key of Object.keys(campsData)) {
          if (Array.isArray(campsData[key]) && campsData[key].length > 0) {
            campaigns = campsData[key];
            break;
          }
        }
      }

      if (campaigns.length === 0) {
        return res.status(200).json({
          campagnes: [],
          periode: { start, end },
          totaal: 0,
          debug: 'Geen campagnes gevonden',
          rawKeys: Object.keys(campsData),
          opgehaaldOp: new Date().toISOString()
        });
      }

      // Stap 2: performance per campagne ophalen
      const enriched = await Promise.all(campaigns.map(async (camp) => {
        const campId = camp.campaignId || camp.id || camp.campaign_id;
        if (!campId) return { ...camp, performance: null };

        try {
          const perfRes = await fetch(
            `${baseUrl}/sponsored-products/campaigns/${campId}/performance?startDate=${start}&endDate=${end}`,
            {
              headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': accept
              }
            }
          );

          if (!perfRes.ok) return { ...camp, performance: null };
          const perf = await perfRes.json();
          return { ...camp, performance: perf };
        } catch {
          return { ...camp, performance: null };
        }
      }));

      // Normaliseer naar ons formaat
      const normalized = enriched.map(camp => {
        const p = camp.performance || {};
        const campId = camp.campaignId || camp.id || camp.campaign_id || '';
        const campName = camp.campaignName || camp.name || camp.campaign_name || `Campagne ${campId}`;

        return {
          naam: campName,
          id: String(campId),
          status: camp.status || camp.campaignStatus || 'UNKNOWN',
          vertoningen: p.impressions || p.vertoningen || 0,
          kliks: p.clicks || p.kliks || 0,
          bestellingen: p.conversions || p.conversions14d || p.orders || p.bestellingen || 0,
          kosten: p.spend || p.cost || p.costs || p.kosten || 0,
          omzet: p.revenue || p.sales || p.sales14d || p.omzet || 0,
          directConv: p.directConversions || p.directConversions14d || 0,
          indirectConv: p.indirectConversions || p.indirectConversions14d || 0,
          periode: { start, end }
        };
      });

      const withData = normalized.filter(c => c.vertoningen > 0 || c.kosten > 0 || c.kliks > 0);

      return res.status(200).json({
        campagnes: withData.length > 0 ? withData : normalized,
        periode: { start, end },
        totaal: normalized.length,
        apiVersion: baseUrl,
        opgehaaldOp: new Date().toISOString()
      });

    } catch (err) {
      lastError = err.message;
      continue;
    }
  }

  // Alle versies mislukt
  return res.status(502).json({
    error: 'Kon geen verbinding maken met bol.com Advertising API',
    detail: lastError,
    hint: 'Controleer of je API credentials de Advertiser scope hebben'
  });
}
