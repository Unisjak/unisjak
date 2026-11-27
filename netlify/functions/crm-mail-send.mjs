// Netlify Function: crm-mail-send  (superadmin sender mail til en kunde/lead fra Kontrolcenter via Resend)
// Kun en indlogget, aktiv superadmin kan kalde den. Mailen lægges i databasen (tråd + besked) og sendes derefter.
// Svar lander på svar-adressen (t-<tråd>@REPLY_DOMAIN) og kobles automatisk på tråden af resend-webhook.
// Miljøvariabler i Netlify:
//   RESEND_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY            (findes allerede)
//   SUPABASE_SERVICE_ROLE_KEY                                  (NY – kun serveren; aldrig i appen)
//   Afsender er fast: Morten fra UniSjak <morten@unisjak.dk>
//   REPLY_DOMAIN     (valgfri, standard svar.unisjak.dk)

import { replyToAddr, mailBodies, FROM_MORTEN } from './_lib/crm-auth.mjs';

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const EMAIL = /^[^@\s<>",;]+@[^@\s<>",;]+\.[^@\s<>",;]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clean = (s, n) => String(s ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, n);

const hits = new Map();
function limited(uid, max = 60) {
  const now = Date.now(), arr = (hits.get(uid) || []).filter(t => now - t < 3600_000);
  if (arr.length >= max) { hits.set(uid, arr); return true; }
  arr.push(now); hits.set(uid, arr); return false;
}

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  const env = process.env;
  if (!env.RESEND_API_KEY || !env.SUPABASE_URL || !env.SUPABASE_ANON_KEY || !env.SUPABASE_SERVICE_ROLE_KEY)
    return json({ error: 'not configured' }, 500);
  const base = env.SUPABASE_URL.replace(/\/+$/, '');
  const from = FROM_MORTEN;

  // 1) Hvem kalder? Kun aktiv superadmin.
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return json({ error: 'unauthorized' }, 401);
  const H = { apikey: env.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + token };
  let user;
  try { const r = await fetch(base + '/auth/v1/user', { headers: H }); if (!r.ok) return json({ error: 'unauthorized' }, 401); user = await r.json(); } catch { return json({ error: 'auth' }, 502); }
  if (!user?.id) return json({ error: 'unauthorized' }, 401);
  let prof;
  try {
    const r = await fetch(`${base}/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=active,is_superadmin,full_name`, { headers: H });
    prof = r.ok ? (await r.json())?.[0] : null;
  } catch { return json({ error: 'auth' }, 502); }
  if (!prof || prof.active !== true || prof.is_superadmin !== true) return json({ error: 'forbidden' }, 403);
  if (limited(user.id)) return json({ error: 'limit' }, 429);

  // 2) Input
  let b; try { b = await req.json(); } catch { return json({ error: 'json' }, 400); }
  const to = clean(b.to, 320).toLowerCase();
  const subject = clean(b.subject, 300);
  const message = String(b.message || '').replace(/\r\n/g, '\n').slice(0, 20000);
  const account = b.account_id && UUID.test(b.account_id) ? b.account_id : null;
  const thread = b.thread_id && UUID.test(b.thread_id) ? b.thread_id : null;
  if (!EMAIL.test(to)) return json({ error: 'to' }, 400);
  if (!subject) return json({ error: 'subject' }, 400);
  if (message.trim().length < 1) return json({ error: 'message' }, 400);

  const S = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY, 'Content-Type': 'application/json' };
  const rpc = async (fn, args) => {
    const r = await fetch(`${base}/rest/v1/rpc/${fn}`, { method: 'POST', headers: S, body: JSON.stringify(args) });
    const t = await r.text(); let d = null; try { d = t ? JSON.parse(t) : null; } catch { /* ignore */ }
    return { ok: r.ok, status: r.status, data: d, text: t };
  };

  // 3) Læg mailen i databasen (tråd + besked i kø). Afviser afmeldte/bounced modtagere.
  const prep = await rpc('mail_prepare_out', { p_account: account, p_thread: thread, p_from: from, p_to: to, p_subject: subject, p_body: message, p_user: user.id });
  if (!prep.ok) {
    const msg = String(prep.data?.message || '');
    if (/frameldt|ikke modtage/i.test(msg)) return json({ error: 'suppressed' }, 409);
    console.error('prepare', prep.status, prep.text.slice(0, 200));
    return json({ error: 'failed' }, 502);
  }
  const row = Array.isArray(prep.data) ? prep.data[0] : prep.data;
  if (!row?.thread_id || !row?.message_id) return json({ error: 'failed' }, 502);

  // 4) Send via Resend. Svar går til tråd-adressen.
  const replyTo = replyToAddr(env, row.thread_id);
  const { html, text } = mailBodies(env, message);
  let resendId = null, err = null;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject, text, html, reply_to: replyTo })
    });
    const t = await r.text();
    if (r.ok) { try { resendId = JSON.parse(t).id || null; } catch { /* ignore */ } if (!resendId) err = 'Resend gav intet id'; }
    else { err = 'Resend ' + r.status; console.error('Resend', r.status, t.slice(0, 300)); }
  } catch (e) { err = 'Resend kunne ikke nås'; console.error(e); }

  await rpc('mail_mark_sent', { p_message: row.message_id, p_resend_id: resendId, p_error: err });
  if (err) return json({ error: 'upstream', thread_id: row.thread_id, message_id: row.message_id }, 502);
  return json({ ok: true, thread_id: row.thread_id, message_id: row.message_id });
};
