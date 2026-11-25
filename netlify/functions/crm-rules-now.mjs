// Netlify Function: superadmin kan køre reglerne med det samme ("Tjek nu" i Kontrolcenteret)
import { json, requireSuperadmin, serviceRpc } from './_lib/crm-auth.mjs';
export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  const env = process.env;
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY || !env.SUPABASE_SERVICE_ROLE_KEY) return json({ error: 'not configured' }, 500);
  const auth = await requireSuperadmin(req, env); if (auth.err) return auth.err;
  const r = await serviceRpc(env)('crm_run_rules', {});
  if (!r.ok) { console.error('rules', r.status, r.text.slice(0, 200)); return json({ error: 'failed' }, 502); }
  return json({ ok: true, created: Number(r.data) || 0 });
};
