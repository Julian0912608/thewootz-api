// api/stores.js — CRUD voor winkelkoppelingen per gebruiker

import { setCors, getSupabase, getUser } from './_lib/supabase.js';

// Simpele encryptie voor MVP (in productie: gebruik Supabase Vault of KMS)
function encryptCred(val) {
  return Buffer.from(val).toString('base64');
}
function decryptCred(val) {
  if (!val) return '';
  try { return Buffer.from(val, 'base64').toString('utf8'); } catch { return ''; }
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: 'Niet ingelogd' });

  const supabase = getSupabase();

  // ── GET: haal alle stores op ──────────────────────────────
  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('stores')
      .select('id, platform, name, is_active, last_synced_at, created_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: true });

    if (error) return res.status(500).json({ error: error.message });

    return res.status(200).json({ stores: data || [] });
  }

  // ── POST: voeg nieuwe store toe ───────────────────────────
  if (req.method === 'POST') {
    const { platform, name, clientId, clientSecret } = req.body || {};

    if (!platform || !clientId || !clientSecret) {
      return res.status(400).json({ error: 'Platform, clientId en clientSecret zijn verplicht' });
    }

    // Valideer bol.com credentials direct
    if (platform === 'bol') {
      const tokenCheck = await validateBolCredentials(clientId, clientSecret);
      if (!tokenCheck.ok) {
        return res.status(400).json({ 
          error: 'Bol.com credentials ongeldig',
          detail: tokenCheck.detail
        });
      }
    }

    const { data, error } = await supabase
      .from('stores')
      .insert({
        user_id: user.id,
        platform,
        name: name || `Mijn ${platform} winkel`,
        client_id_enc: encryptCred(clientId),
        client_secret_enc: encryptCred(clientSecret)
      })
      .select('id, platform, name, created_at')
      .single();

    if (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'Deze winkel is al gekoppeld' });
      return res.status(500).json({ error: error.message });
    }

    return res.status(201).json({ store: data, message: 'Winkel succesvol gekoppeld!' });
  }

  // ── DELETE: verwijder store ───────────────────────────────
  if (req.method === 'DELETE') {
    const storeId = req.query.id;
    if (!storeId) return res.status(400).json({ error: 'Store ID verplicht' });

    const { error } = await supabase
      .from('stores')
      .delete()
      .eq('id', storeId)
      .eq('user_id', user.id);

    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ message: 'Winkel verwijderd' });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

// Helper: valideer bol.com credentials door een token te halen
async function validateBolCredentials(clientId, clientSecret) {
  try {
    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const r = await fetch('https://login.bol.com/token?grant_type=client_credentials', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });
    if (!r.ok) return { ok: false, detail: 'Ongeldige Client ID of Secret' };
    return { ok: true };
  } catch (e) {
    return { ok: false, detail: e.message };
  }
}
