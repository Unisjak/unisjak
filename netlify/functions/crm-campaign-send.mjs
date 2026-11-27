// Netlify Function: crm-campaign-send  (superadmin sender næste portion af en udsendelse)
// Kaldes gentagne gange af Kontrolcenteret, indtil remaining = 0. Hver modtager får sin egen tråd, så svar lander i indbakken.
// Afmeldte/bounced modtagere springes over. Miljø: RESEND_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
import { FROM_MORTEN, json, UUID, requireSuperadmin, serviceRpc, fillTpl, sleep, sendViaResend } from './_lib/crm-auth.mjs';

const hits = new Map();
function limited(uid, max = 60) {   // højst 60 portioner i timen (≈ 600 mails)
  const now = Date.now(), arr = (hits.get(uid) || []).filter(t => now - t < 3600_000);
  if (arr.length >= max) { hits.set(uid, arr); return true; }
  arr.push(now); hits.set(uid, arr); return false;
}

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  const env = process.env;
  const from = FROM_MORTEN;
  if (!env.RESEND_API_KEY || !env.SUPABASE_URL || !env.SUPABASE_ANON_KEY || !env.SUPABASE_SERVICE_ROLE_KEY) return json({ error: 'not configured' }, 500);
  const auth = await requireSuperadmin(req, env); if (auth.err) return auth.err;
  if (limited(auth.user.id)) return json({ error: 'limit' }, 429);
  let b; try { b = await req.json(); } catch { return json({ error: 'json' }, 400); }
  if (!UUID.test(b.campaign_id || '')) return json({ error: 'campaign' }, 400);
  const rpc = serviceRpc(env);

  const batch = await rpc('campaign_next_batch', { p_campaign: b.campaign_id, p_user: auth.user.id, p_n: 10 });
  if (!batch.ok) { console.error('batch', batch.status, batch.text.slice(0, 200)); return json({ error: 'failed' }, 502); }
  const rows = Array.isArray(batch.data) ? batch.data : [];
  let sent = 0, skipped = 0, failed = 0, remaining = null, status = 'sending';
  for (const r of rows) {
    const subject = fillTpl(r.subject, r.name, r.company).slice(0, 300), message = fillTpl(r.body, r.name, r.company);
    let outcome = 'failed', error = null;
    const prep = await rpc('mail_prepare_out', { p_account: r.account_id, p_thread: null, p_from: from, p_to: r.email, p_subject: subject, p_body: message, p_user: auth.user.id });
    if (!prep.ok) {
      if (/frameldt|ikke modtage/i.test(String(prep.data?.message || ''))) { outcome = 'skipped'; error = 'afmeldt'; } else { error = 'kunne ikke forberedes'; console.error('prep', prep.status, prep.text.slice(0, 200)); }
    } else {
      const row = Array.isArray(prep.data) ? prep.data[0] : prep.data;
      if (!row?.thread_id || !row?.message_id) error = 'tom tråd';
      else {
        const s = await sendViaResend(env, { from, to: r.email, subject, message, threadId: row.thread_id });
        await rpc('mail_mark_sent', { p_message: row.message_id, p_resend_id: s.id || null, p_error: s.err || null });
        if (s.id) outcome = 'sent'; else error = s.err;
        await sleep(550);                                   // Resend tillader ca. 2 kald i sekundet
      }
    }
    const m = await rpc('campaign_mark', { p_rid: r.rid, p_status: outcome, p_error: error });
    const mm = Array.isArray(m.data) ? m.data[0] : m.data; if (mm) { remaining = mm.remaining; status = mm.camp_status; }
    if (outcome === 'sent') sent++; else if (outcome === 'skipped') skipped++; else failed++;
  }
  return json({ ok: true, sent, skipped, failed, remaining: remaining ?? (rows.length ? null : 0), status: rows.length ? status : 'done' });
};
