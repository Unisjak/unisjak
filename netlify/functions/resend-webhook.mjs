// Netlify Function: resend-webhook  (Resend -> UniSjak)
// Modtager statusbegivenheder for udgående mail (sendt/leveret/åbnet/bounced/klage) og indgående svar (email.received).
// Sikkerhed: hver forespørgsel verificeres med Resends (Svix-)signatur. Databasen skrives med service-nøglen (kun her).
// Miljøvariabler i Netlify: RESEND_API_KEY, RESEND_WEBHOOK_SECRET (whsec_…), SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Webhook-adresse i Resend:  https://unisjak.dk/.netlify/functions/resend-webhook
// Events: email.sent, email.delivered, email.bounced, email.complained, email.opened, email.received

import { createHmac, timingSafeEqual } from 'node:crypto';

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const STATUS = { 'email.sent': 'sent', 'email.delivered': 'delivered', 'email.opened': 'opened', 'email.bounced': 'bounced', 'email.complained': 'complained' };
const STOP = /^\s*(afmeld|afmelding|stop|unsubscribe|frameld)\b/i;

export function verifySvix(secret, headers, body, now = Date.now()) {
  const id = headers.get('svix-id'), ts = headers.get('svix-timestamp'), sig = headers.get('svix-signature');
  if (!id || !ts || !sig || !secret) return false;
  const t = Number(ts);
  if (!Number.isFinite(t) || Math.abs(now / 1000 - t) > 300) return false;                 // højst 5 minutter gammel
  let key;
  try { key = Buffer.from(String(secret).replace(/^whsec_/, ''), 'base64'); } catch { return false; }
  if (!key.length) return false;
  const expected = createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest();
  for (const part of String(sig).split(' ')) {
    const [v, s] = part.split(',');
    if (v !== 'v1' || !s) continue;
    let got; try { got = Buffer.from(s, 'base64'); } catch { continue; }
    if (got.length === expected.length && timingSafeEqual(got, expected)) return true;
  }
  return false;
}

const stripHtml = h => String(h || '').replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, '')
  .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>/gi, '\n').replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
  .replace(/\n{3,}/g, '\n\n').trim();
const bare = s => { const m = String(s || '').match(/<([^>]+)>/); return (m ? m[1] : String(s || '')).trim().toLowerCase(); };
const toUuid = h => h.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
const hdr = (h, k) => { if (!h) return null; if (Array.isArray(h)) { const x = h.find(e => String(e.name || '').toLowerCase() === k); return x ? x.value : null; } const key = Object.keys(h).find(x => x.toLowerCase() === k); return key ? h[key] : null; };

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  const env = process.env;
  if (!env.RESEND_WEBHOOK_SECRET || !env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY || !env.RESEND_API_KEY) return json({ error: 'not configured' }, 500);
  const raw = await req.text();
  if (raw.length > 1_000_000) return json({ error: 'size' }, 413);
  if (!verifySvix(env.RESEND_WEBHOOK_SECRET, req.headers, raw)) return json({ error: 'signature' }, 401);

  let ev; try { ev = JSON.parse(raw); } catch { return json({ error: 'json' }, 400); }
  const type = String(ev?.type || ''), d = ev?.data || {};
  const base = env.SUPABASE_URL.replace(/\/+$/, '');
  const S = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY, 'Content-Type': 'application/json' };
  const rpc = async (fn, args) => { const r = await fetch(`${base}/rest/v1/rpc/${fn}`, { method: 'POST', headers: S, body: JSON.stringify(args) }); if (!r.ok) throw new Error(fn + ' ' + r.status + ' ' + (await r.text()).slice(0, 200)); };

  try {
    if (STATUS[type] && d.email_id) {
      await rpc('mail_apply_status', { p_resend_id: String(d.email_id), p_status: STATUS[type], p_at: ev.created_at || d.created_at || new Date().toISOString() });
    } else if (type === 'email.received' && d.email_id) {
      // Webhook'en indeholder kun metadata – selve teksten hentes hos Resend
      const r = await fetch('https://api.resend.com/emails/receiving/' + encodeURIComponent(d.email_id), { headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY } });
      if (!r.ok) throw new Error('hent mail ' + r.status);
      const m = await r.json();
      const from = bare(m.from || d.from);
      const tos = (Array.isArray(m.to) ? m.to : (Array.isArray(d.to) ? d.to : [])).map(bare);
      let thread = null;
      for (const a of [...tos, ...(Array.isArray(d.received_for) ? d.received_for.map(bare) : [])]) { const t = a.match(/^t-([0-9a-f]{32})@/); if (t) { thread = toUuid(t[1]); break; } }
      const text = String(m.text || stripHtml(m.html) || '').slice(0, 100000);
      const atts = (Array.isArray(m.attachments) ? m.attachments : (Array.isArray(d.attachments) ? d.attachments : []))
        .slice(0, 20).map(a => ({ id: a.id, filename: String(a.filename || '').slice(0, 200), content_type: a.content_type, size: a.size || null }));
      await rpc('mail_ingest_in', {
        p_resend_id: String(d.email_id), p_message_id: m.message_id || d.message_id || null,
        p_in_reply_to: hdr(m.headers, 'in-reply-to') || null, p_thread: thread,
        p_from: from, p_to: tos, p_subject: String(m.subject || d.subject || ''), p_text: text, p_attachments: atts
      });
      if (STOP.test(text)) {   // modtageren beder om at blive fjernet
        await fetch(`${base}/rest/v1/mail_suppressions?on_conflict=email`, { method: 'POST', headers: { ...S, Prefer: 'resolution=ignore-duplicates,return=minimal' }, body: JSON.stringify({ email: from, reason: 'afmeldt' }) });
      }
    }
    // Revisionsspor (samme hændelse logges kun én gang)
    const svixId = req.headers.get('svix-id');
    await fetch(`${base}/rest/v1/mail_events?on_conflict=svix_id`, {
      method: 'POST', headers: { ...S, Prefer: 'resolution=ignore-duplicates,return=minimal' },
      body: JSON.stringify({ svix_id: svixId, type: type.slice(0, 80), resend_id: d.email_id ? String(d.email_id) : null, payload: { to: d.to || null, subject: d.subject || null, from: d.from || null } })
    });
    return json({ ok: true });
  } catch (e) {
    console.error(e);
    return json({ error: 'failed' }, 500);          // Resend prøver igen
  }
};
