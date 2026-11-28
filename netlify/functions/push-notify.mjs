// Netlify Function: push-notify  (sender push-notifikation til kolleger i SAMME virksomhed, fx når en opgave tildeles)
// POST { user_ids: [uuid], managers?: true (send også til virksomhedens admins), title, body, url?, tag? }  – kræver indlogget, aktiv bruger.
// Miljø: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY (+ VAPID_SUBJECT)
import { json, UUID } from './_lib/crm-auth.mjs';
import { sendPush } from './_lib/webpush.mjs';

const hits = new Map();
function limited(uid, max = 150) {
  const now = Date.now(), arr = (hits.get(uid) || []).filter(t => now - t < 3600_000);
  if (arr.length >= max) { hits.set(uid, arr); return true; }
  arr.push(now); hits.set(uid, arr); return false;
}
const clean = (s, n) => String(s ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, n);

export default async (req, _ctx, deps = {}) => {
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  const env = deps.env || process.env, f = deps.fetch || fetch, send = deps.send || sendPush;
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY || !env.SUPABASE_SERVICE_ROLE_KEY || !env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return json({ error: 'not configured' }, 500);
  const base = env.SUPABASE_URL.replace(/\/+$/, '');
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return json({ error: 'unauthorized' }, 401);
  const U = { apikey: env.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + token };
  const S = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY };
  let user, me;
  try {
    const r = await f(base + '/auth/v1/user', { headers: U }); if (!r.ok) return json({ error: 'unauthorized' }, 401); user = await r.json();
    const p = await f(`${base}/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=company_id,active,full_name`, { headers: U }); me = p.ok ? (await p.json())?.[0] : null;
  } catch { return json({ error: 'auth' }, 502); }
  if (!user?.id || !me || me.active !== true || !me.company_id) return json({ error: 'forbidden' }, 403);
  if (limited(user.id)) return json({ error: 'limit' }, 429);
  let b; try { b = await req.json(); } catch { return json({ error: 'json' }, 400); }
  const ids = [...new Set((Array.isArray(b.user_ids) ? b.user_ids : []).filter(x => UUID.test(String(x)) && x !== user.id))].slice(0, 20);
  const title = clean(b.title, 80), body = clean(b.body, 200);
  const wantMgr = b.managers === true;
  if ((!ids.length && !wantMgr) || !title) return json({ error: 'input' }, 400);
  let url = String(b.url || '/'); if (!/^\/[^/\\]*$/.test(url) && url !== '/') url = '/';
  try {
    // kun kolleger i samme virksomhed og aktive
    let cand = [...ids];
    if (wantMgr) { const mr = await f(`${base}/rest/v1/profiles?company_id=eq.${me.company_id}&role=in.(admin,formand)&active=eq.true&select=id`, { headers: S }); if (mr.ok) cand.push(...(await mr.json()).map(x => x.id).filter(x => UUID.test(String(x)) && x !== user.id)); }
    cand = [...new Set(cand)].slice(0, 40); if (!cand.length) return json({ ok: true, sent: 0 });
    const q = `${base}/rest/v1/profiles?id=in.(${cand.join(',')})&company_id=eq.${me.company_id}&active=eq.true&select=id`;
    const pr = await f(q, { headers: S }); const ok = pr.ok ? (await pr.json()).map(x => x.id) : [];
    if (!ok.length) return json({ ok: true, sent: 0 });
    const sr = await f(`${base}/rest/v1/push_subscriptions?user_id=in.(${ok.join(',')})&select=id,endpoint,p256dh,auth`, { headers: S });
    const subs = sr.ok ? await sr.json() : [];
    const payload = { title, body, url, tag: clean(b.tag, 60) || undefined };
    let sent = 0; const dead = [];
    await Promise.all(subs.map(async s => { const r = await send(s, payload, env, f); if (r.ok) sent++; else if (r.gone) dead.push(s.id); else console.error('push', r.status, r.error || ''); }));
    if (dead.length) await f(`${base}/rest/v1/push_subscriptions?id=in.(${dead.join(',')})`, { method: 'DELETE', headers: S });
    return json({ ok: true, sent, devices: subs.length });
  } catch (e) { console.error('push-notify', e); return json({ error: 'failed' }, 502); }
};
