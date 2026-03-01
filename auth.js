// api/auth.js — register + login via Supabase Auth

import { createClient } from '@supabase/supabase-js';
import { setCors } from './_lib/supabase.js';

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
  );

  const { action, email, password, fullName } = req.body || {};

  // ── REGISTER ─────────────────────────────────────────────
  if (action === 'register') {
    if (!email || !password) {
      return res.status(400).json({ error: 'Email en wachtwoord zijn verplicht' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Wachtwoord moet minimaal 8 tekens zijn' });
    }

    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { full_name: fullName || '' } }
    });

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    return res.status(200).json({
      message: 'Account aangemaakt! Check je email om te bevestigen.',
      user: { id: data.user?.id, email: data.user?.email },
      session: data.session
    });
  }

  // ── LOGIN ─────────────────────────────────────────────────
  if (action === 'login') {
    if (!email || !password) {
      return res.status(400).json({ error: 'Email en wachtwoord zijn verplicht' });
    }

    const { data, error } = await supabase.auth.signInWithPassword({ email, password });

    if (error) {
      const msg = error.message.includes('Invalid login') 
        ? 'Ongeldig email of wachtwoord' 
        : error.message;
      return res.status(401).json({ error: msg });
    }

    return res.status(200).json({
      user: {
        id: data.user.id,
        email: data.user.email,
        fullName: data.user.user_metadata?.full_name || ''
      },
      session: {
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_at: data.session.expires_at
      }
    });
  }

  // ── REFRESH TOKEN ─────────────────────────────────────────
  if (action === 'refresh') {
    const { refreshToken } = req.body;
    if (!refreshToken) return res.status(400).json({ error: 'Geen refresh token' });

    const { data, error } = await supabase.auth.refreshSession({ refresh_token: refreshToken });
    if (error) return res.status(401).json({ error: 'Sessie verlopen, log opnieuw in' });

    return res.status(200).json({
      session: {
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_at: data.session.expires_at
      }
    });
  }

  // ── LOGOUT ────────────────────────────────────────────────
  if (action === 'logout') {
    return res.status(200).json({ message: 'Uitgelogd' });
  }

  return res.status(400).json({ error: 'Onbekende actie' });
}
