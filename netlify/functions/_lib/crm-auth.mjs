// Fælles hjælpere til CRM-funktioner: kun en indlogget, aktiv superadmin må kalde dem.
export const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function requireSuperadmin(req, env) {
  const base = env.SUPABASE_URL.replace(/\/+$/, '');
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return { err: json({ error: 'unauthorized' }, 401) };
  const H = { apikey: env.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + token };
  let user;
  try { const r = await fetch(base + '/auth/v1/user', { headers: H }); if (!r.ok) return { err: json({ error: 'unauthorized' }, 401) }; user = await r.json(); } catch { return { err: json({ error: 'auth' }, 502) }; }
  if (!user?.id) return { err: json({ error: 'unauthorized' }, 401) };
  let prof;
  try { const r = await fetch(`${base}/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=active,is_superadmin`, { headers: H }); prof = r.ok ? (await r.json())?.[0] : null; } catch { return { err: json({ error: 'auth' }, 502) }; }
  if (!prof || prof.active !== true || prof.is_superadmin !== true) return { err: json({ error: 'forbidden' }, 403) };
  return { user, base };
}

export function serviceRpc(env) {
  const base = env.SUPABASE_URL.replace(/\/+$/, '');
  const S = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY, 'Content-Type': 'application/json' };
  return async (fn, args) => {
    const r = await fetch(`${base}/rest/v1/rpc/${fn}`, { method: 'POST', headers: S, body: JSON.stringify(args || {}) });
    const t = await r.text(); let d = null; try { d = t ? JSON.parse(t) : null; } catch { /* ignore */ }
    return { ok: r.ok, status: r.status, data: d, text: t };
  };
}

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const fillTpl = (txt, name, company) => String(txt || '').replace(/\{navn\}/g, (String(name || '').trim().split(/\s+/)[0]) || 'der').replace(/\{virksomhed\}/g, company || '');
export const sleep = ms => new Promise(r => setTimeout(r, ms));

// Faste afsenderadresser: systemmails sendes fra noreply@ (svar går til hej@), Mortens egne mails fra morten@.
export const FROM_SYSTEM = 'UniSjak <noreply@unisjak.dk>';
export const FROM_MORTEN = 'Morten fra UniSjak <morten@unisjak.dk>';
export const REPLY_MAIN = 'hej@unisjak.dk';

// Svar-adresse med visningsnavn, så mailprogrammet viser et navn i stedet for den lange tråd-kode.
export function replyToAddr(env, threadId) {
  const dom = (env.REPLY_DOMAIN || 'svar.unisjak.dk').trim();
  const nm = String(env.CRM_REPLY_NAME || 'Morten fra UniSjak').replace(/["<>\r\n]/g, '').trim() || 'UniSjak';
  return `${nm} <t-${String(threadId).replace(/-/g, '')}@${dom}>`;
}

// Mailkrop: brevteksten + fast signatur (med logo) + lille afmeldingslinje. Tekstversionen kan altid stå alene.
export function mailBodies(env, message) {
  const sig = {
    name: env.SIGNATURE_NAME || 'Morten Kampmann Jacobsen',
    phone: env.SIGNATURE_PHONE || '53 38 16 49',
    email: env.SIGNATURE_EMAIL || 'morten@unisjak.dk',
    web: 'unisjak.dk'
  };
  const logo = (env.MAIL_LOGO_URL || 'https://unisjak.dk/mail-logo.png').trim();
  const foot = 'Svar blot på denne mail. Vil du ikke høre fra os igen, så svar "afmeld".';
  const text = message + `\n\n--\n${sig.name}\n${sig.phone} · ${sig.email}\n${sig.web}\n\n${foot}`;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#1c1917"><div style="white-space:pre-wrap">${esc(message)}</div>` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:26px;border-top:1px solid #e7e5e4;padding-top:14px"><tr>` +
    `<td style="vertical-align:top;padding:14px 14px 0 0"><a href="https://${esc(sig.web)}"><img src="${esc(logo)}" width="56" height="58" alt="UniSjak" style="display:block;border:0"></a></td>` +
    `<td style="vertical-align:top;padding-top:14px;font-size:13px;line-height:1.5;color:#44403c">` +
    `<div style="font-size:15px;font-weight:bold;color:#1c1917">${esc(sig.name)}</div>` +
    `<div>${esc(sig.phone)} &middot; <a href="mailto:${esc(sig.email)}" style="color:#ea580c;text-decoration:none">${esc(sig.email)}</a></div>` +
    `<div><a href="https://${esc(sig.web)}" style="color:#ea580c;text-decoration:none">${esc(sig.web)}</a></div></td></tr></table>` +
    `<p style="margin-top:18px;font-size:11px;color:#a8a29e">${esc(foot)}</p></div>`;
  return { html, text };
}

// Send én mail via Resend. Svar går til tråd-adressen, så de lander i Kontrolcenterets indbakke.
export async function sendViaResend(env, { from, to, subject, message, threadId }) {
  const replyTo = replyToAddr(env, threadId);
  const { html, text } = mailBodies(env, message);
  try {
    const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject, text, html, reply_to: replyTo }) });
    const t = await r.text();
    if (!r.ok) { console.error('Resend', r.status, t.slice(0, 300)); return { err: 'Resend ' + r.status, status: r.status }; }
    let id = null; try { id = JSON.parse(t).id || null; } catch { /* ignore */ }
    return id ? { id } : { err: 'Resend gav intet id' };
  } catch (e) { console.error(e); return { err: 'Resend kunne ikke nås' }; }
}
