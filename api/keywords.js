// api/keywords.js
// Zoekwoord-niveau performance per campagne

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
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Geen geldig Bearer token' });
  }

  const token = authHeader.split(' ')[1];
  const { campaignId, startDate, endDate } = req.query;

  if (!campaignId) {
    return res.status(400).json({ error: 'campaignId is verplicht' });
  }

  const end   = endDate   || new Date().toISOString().split('T')[0];
  const start = startDate || new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];

  try {
    // Haal ad groups op voor deze campagne
    const adGroupRes = await fetch(
      `${BOL_API}/sponsored-products/campaigns/${campaignId}/ad-groups`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.advertiser.v9+json'
        }
      }
    );

    if (!adGroupRes.ok) {
      return res.status(adGroupRes.status).json({ error: 'Ad groups ophalen mislukt' });
    }

    const adGroupData = await adGroupRes.json();
    const adGroups = adGroupData.adGroups || adGroupData.content || [];

    // Per ad group: haal targeting/keywords op
    const keywordData = [];

    for (const ag of adGroups.slice(0, 5)) { // max 5 ad groups om rate limit te voorkomen
      try {
        const kwRes = await fetch(
          `${BOL_API}/sponsored-products/ad-groups/${ag.adGroupId}/targeting-clauses?` +
          `startDate=${start}&endDate=${end}`,
          {
            headers: {
              'Authorization': `Bearer ${token}`,
              'Accept': 'application/vnd.advertiser.v9+json'
            }
          }
        );

        if (kwRes.ok) {
          const kwData = await kwRes.json();
          const clauses = kwData.targetingClauses || kwData.content || [];
          clauses.forEach(kw => {
            keywordData.push({
              adGroupId: ag.adGroupId,
              adGroupName: ag.name || ag.adGroupName,
              zoekwoord: kw.expression || kw.keyword || kw.value,
              matchType: kw.matchType || 'BROAD',
              vertoningen: kw.impressions || 0,
              kliks: kw.clicks || 0,
              kosten: kw.spend || kw.cost || 0,
              bestellingen: kw.conversions || 0,
              omzet: kw.revenue || kw.sales || 0
            });
          });
        }
      } catch { /* skip failed ad group */ }
    }

    return res.status(200).json({
      campaignId,
      zoekwoorden: keywordData.sort((a, b) => b.kosten - a.kosten),
      periode: { start, end }
    });

  } catch (err) {
    return res.status(500).json({ error: 'Interne serverfout', detail: err.message });
  }
}
