// api/_lib/supabase.js — gedeelde Supabase client + CORS helper

import { createClient } from '@supabase/supabase-js';

export function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-User-Token');
}

export function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY  // service key voor server-side bewerkingen
  );
}

// Haal de ingelogde gebruiker op via hun JWT token
export async function getUser(req) {
  const token = req.headers['x-user-token'];
  if (!token) return null;
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
  );
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return null;
  return user;
}
