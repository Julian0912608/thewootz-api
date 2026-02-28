// api/campaigns.js — bol.com Advertiser API v11
// V11 gebruikt PUT filter endpoints i.p.v. GET

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
    'Accept': 'application/json',
    'Content-Type': 'application/json'
  };

  try {
    // V11 gebruikt PUT met filter body voor campaigns
    const campsRes = await fetch(`${BASE}/campaigns`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ page: 0, pageSize: 100 })
    });

    if (!campsRes.ok) {
      const errBody = await campsRes.text();
      return res.status(campsRes.status).json({
        error: `Campagnes ophalen mislukt (${campsRes.status})`,
        detail: errBody.substring(0, 300),
        hint: campsRes.status === 403
          ? 'Gebruik de Advertising API credentials (niet de Retailer API credentials)'
          : `HTTP ${campsRes.status}`
      });
    }

    const campsData = await campsRes.json();
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
        campagnes: [],
        periode: { start, end },
        totaal: 0,
        bericht: 'Geen campagnes gevonden'
      });
    }

    // Performance per campagne ophalen via PUT reporting endpoint
    const campIds = campaigns.map(c => c.campaignId || c.id).filter(Boolean);

    let performanceMap = {};
    try {
      const perfRes = await fetch(`${BASE}/reporting/campaigns/performance`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          campaignIds: campIds,
          startDate: start,
          endDate: end
        })
      });
      if (perfRes.ok) {
        const perfData = await perfRes.json();
        const perfList = Array.isArray(perfData) ? perfData
          : perfData.campaigns || perfData.content || perfData.data || perfData.items || [];
        perfList.forEach(p => {
          const id = p.campaignId || p.id;
          if (id) performanceMap[String(id)] = p;
        });
      }
    } catch {}

    const enriched = campaigns.map(camp => {
      const campId = String(camp.campaignId || camp.id || '');
      const campName = camp.campaignName || camp.name || `Campagne ${campId}`;
      const p = performanceMap[campId] || {};
      return {
        naam: campName,
        id: campId,
        status: camp.status || camp.campaignStatus || 'UNKNOWN',
        vertoningen: p.impressions || 0,
        kliks: p.clicks || 0,
        bestellingen: p.conversions14d || p.conversions || p.orders || 0,
        kosten: p.spend || p.cost || p.costs || 0,
        omzet: p.sales14d || p.sales || p.revenue || 0,
        directConv: p.directConversions14d || 0,
        indirectConv: p.indirectConversions14d || 0,
        periode: { start, end }
      };
    });

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
