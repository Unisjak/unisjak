// Sender en push-notifikation til superadmin(erne) (Mortens telefon). Fejl er altid stille – kalderen må aldrig fejle pga. push.
// Miljø: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY
import { sendPush } from './webpush.mjs';
const clean = (s, n) => String(s ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, n);

export async function notifySuper(env, p, f = fetch, send = sendPush) {
  try {
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY || !env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return 0;
    const base = env.SUPABASE_URL.replace(/\/+$/, '');
    const S = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY };
    const pr = await f(`${base}/rest/v1/profiles?is_superadmin=eq.true&active=eq.true&select=id`, { headers: S });
    const ids = pr.ok ? (await pr.json()).map(x => x.id) : [];
    if (!ids.length) return 0;
    const sr = await f(`${base}/rest/v1/push_subscriptions?user_id=in.(${ids.join(',')})&select=id,endpoint,p256dh,auth`, { headers: S });
    const subs = sr.ok ? await sr.json() : [];
    if (!subs.length) return 0;
    const payload = { title: clean(p.title, 80), body: clean(p.body, 180), url: '/?open=sa', tag: clean(p.tag, 60) || undefined };
    let sent = 0; const dead = [];
    await Promise.all(subs.map(async s => { const r = await send(s, payload, env, f); if (r.ok) sent++; else if (r.gone) dead.push(s.id); else console.error('push-super', r.status, r.error || ''); }));
    if (dead.length) await f(`${base}/rest/v1/push_subscriptions?id=in.(${dead.join(',')})`, { method: 'DELETE', headers: S });
    return sent;
  } catch (e) { console.error('notifySuper', e && e.message); return 0; }
}
