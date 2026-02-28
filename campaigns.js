// api/campaigns.js
// Proxy naar bol.com Advertising API — campagne performance data

const BOL_API = 'https://api.bol.com/advertiser/v9';

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

  // Query params: startDate, endDate (YYYY-MM-DD), optional: campaignId
  const { startDate, endDate, campaignId } = req.query;

  // Default: afgelopen 30 dagen
  const end   = endDate   || new Date().toISOString().split('T')[0];
  const start = startDate || new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];

  try {
    // 1. Haal alle campagnes op
    const campsRes = await fetch(`${BOL_API}/sponsored-products/campaigns`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.advertiser.v9+json'
      }
    });

    if (!campsRes.ok) {
      const err = await campsRes.text();
      return res.status(campsRes.status).json({ error: 'Campagnes ophalen mislukt', detail: err });
    }

    const campsData = await campsRes.json();
    const campaigns = campsData.campaigns || campsData.content || campsData || [];

    // 2. Haal performance per campagne op
    const performancePromises = campaigns.map(async (camp) => {
      try {
        const perfRes = await fetch(
          `${BOL_API}/sponsored-products/campaigns/${camp.campaignId}/performance?` +
          `startDate=${start}&endDate=${end}`,
          {
            headers: {
              'Authorization': `Bearer ${token}`,
              'Accept': 'application/vnd.advertiser.v9+json'
            }
          }
        );

        if (!perfRes.ok) return { ...camp, performance: null };

        const perf = await perfRes.json();
        return { ...camp, performance: perf };
      } catch {
        return { ...camp, performance: null };
      }
    });

    const enriched = await Promise.all(performancePromises);

    // 3. Normaliseer naar ons interne formaat
    const normalized = enriched.map(camp => {
      const p = camp.performance;
      return {
        naam: camp.campaignName || camp.name || `Campagne ${camp.campaignId}`,
        id: camp.campaignId,
        status: camp.status || 'UNKNOWN',
        vertoningen: p?.impressions || 0,
        kliks: p?.clicks || 0,
        bestellingen: p?.conversions || p?.orders || 0,
        kosten: p?.spend || p?.cost || 0,
        omzet: p?.revenue || p?.sales || 0,
        directConv: p?.directConversions || 0,
        indirectConv: p?.indirectConversions || 0,
        cpc: p?.averageCpc || 0,
        acos: p?.acos || 0,
        roas: p?.roas || 0,
        periode: { start, end }
      };
    }).filter(c => c.vertoningen > 0 || c.kosten > 0 || c.kliks > 0);

    return res.status(200).json({
      campagnes: normalized,
      periode: { start, end },
      totaal: normalized.length,
      opgehaaldOp: new Date().toISOString()
    });

  } catch (err) {
    console.error('Campaigns handler error:', err);
    return res.status(500).json({ error: 'Interne serverfout', detail: err.message });
  }
}
