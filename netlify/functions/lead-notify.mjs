// Netlify Function: lead-notify  (kaldes af forsiden lige efter en henvendelse)
// Sender én mail til Morten og en kort bekræftelse til leadet. Kan kun udløses én gang pr. lead (lead_notify_claim).
// Miljø: RESEND_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
import { notifySuper } from './_lib/notify-super.mjs';
import { FROM_SYSTEM, REPLY_MAIN, json, UUID, serviceRpc, esc } from './_lib/crm-auth.mjs';

const hits = new Map();
function limited(max = 30) {
  const now = Date.now(), arr = (hits.get('all') || []).filter(t => now - t < 3600_000);
  if (arr.length >= max) { hits.set('all', arr); return true; }
  arr.push(now); hits.set('all', arr); return false;
}
async function send(env, payload) {
  const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: FROM_SYSTEM, ...payload }) });
  if (!r.ok) console.error('Resend', r.status, (await r.text().catch(() => '')).slice(0, 200));
  return r.ok;
}

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  const env = process.env;
  if (!env.RESEND_API_KEY || !env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return json({ error: 'not configured' }, 500);
  if (limited()) return json({ error: 'limit' }, 429);
  let b; try { b = await req.json(); } catch { return json({ error: 'json' }, 400); }
  if (!UUID.test(b.id || '')) return json({ error: 'id' }, 400);
  const claim = await serviceRpc(env)('lead_notify_claim', { p_id: b.id });
  if (!claim.ok) { console.error('claim', claim.status, claim.text.slice(0, 200)); return json({ error: 'failed' }, 502); }
  const l = claim.data;
  if (!l) return json({ ok: true, sent: false });
  const line = (k, v) => v ? `<p style="margin:4px 0"><b>${k}:</b> ${esc(v)}</p>` : '';
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#12233F">${line('Navn', l.name)}${line('Virksomhed', l.company)}${line('E-mail', l.email)}${line('Telefon', l.phone)}${line('Kilde', l.source)}<p style="margin:14px 0 4px"><b>Besked</b></p><p style="white-space:pre-wrap;margin:0">${esc(String(l.text || '').replace(/^Henvendelse fra forsiden:?\s*/, ''))}</p><p style="color:#566070;font-size:12px;margin-top:18px">Ligger nu som lead i Kontrolcenteret.</p></div>`;
  const a = await send(env, { to: 'morten@unisjak.dk', reply_to: l.email, subject: `Nyt lead: ${l.company} – ${l.name}`, html });
  await notifySuper(env, { title: 'Nyt lead: ' + (l.company || l.name || ''), body: [l.name, l.phone, l.email].filter(Boolean).join(' · '), tag: 'lead-' + b.id });
  const first = String(l.name || '').trim().split(/\s+/)[0] || 'der';
  await send(env, { to: l.email, reply_to: REPLY_MAIN, subject: 'Tak for din henvendelse til UniSjak', html: `<div style="font-family:Arial,Helvetica,sans-serif;color:#12233F"><p>Hej ${esc(first)},</p><p>Tak for din henvendelse. Vi vender tilbage samme dag.</p><p>Du kan altid svare direkte på denne mail.</p><p>Mvh<br>UniSjak</p></div>` });
  return json({ ok: true, sent: a });
};
