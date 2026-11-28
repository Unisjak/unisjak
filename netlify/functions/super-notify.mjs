// Netlify Function: super-notify  (kaldes af appen lige efter en NY virksomhed er oprettet ved selvtilmelding)
// Sender en push til superadmin: "Ny virksomhed: <navn>". Indholdet hentes fra databasen – klienten kan ikke bestemme teksten.
// Kræver indlogget bruger hvis virksomhed er oprettet inden for de seneste 30 minutter. Miljø som push-notify.
import { json } from './_lib/crm-auth.mjs';
import { notifySuper } from './_lib/notify-super.mjs';

const done = new Set();
export default async (req, _ctx, deps = {}) => {
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  const env = deps.env || process.env, f = deps.fetch || fetch, notify = deps.notify || notifySuper;
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY || !env.SUPABASE_SERVICE_ROLE_KEY) return json({ error: 'not configured' }, 500);
  const base = env.SUPABASE_URL.replace(/\/+$/, '');
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return json({ error: 'unauthorized' }, 401);
  const U = { apikey: env.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + token };
  const S = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY };
  try {
    const r = await f(base + '/auth/v1/user', { headers: U }); if (!r.ok) return json({ error: 'unauthorized' }, 401);
    const user = await r.json();
    const p = await f(`${base}/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=company_id,is_superadmin,full_name`, { headers: U });
    const me = p.ok ? (await p.json())?.[0] : null;
    if (!me || !me.company_id || me.is_superadmin) return json({ ok: true, sent: 0 });
    if (done.has(me.company_id)) return json({ ok: true, sent: 0 });
    const c = await f(`${base}/rest/v1/companies?id=eq.${encodeURIComponent(me.company_id)}&select=name,created_at`, { headers: S });
    const co = c.ok ? (await c.json())?.[0] : null;
    if (!co || Date.now() - new Date(co.created_at).getTime() > 30 * 60_000) return json({ ok: true, sent: 0 });
    done.add(me.company_id);
    const sent = await notify(env, { title: 'Ny virksomhed: ' + co.name, body: (me.full_name ? me.full_name + ' · ' : '') + 'har oprettet en prøveperiode', tag: 'signup-' + me.company_id }, f);
    return json({ ok: true, sent });
  } catch (e) { console.error('super-notify', e && e.message); return json({ error: 'failed' }, 502); }
};
