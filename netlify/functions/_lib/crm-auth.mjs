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

// Send én mail via Resend. Svar går til tråd-adressen, så de lander i Kontrolcenterets indbakke.
export async function sendViaResend(env, { from, to, subject, message, threadId }) {
  const replyDomain = (env.REPLY_DOMAIN || 'svar.unisjak.dk').trim();
  const replyTo = `t-${threadId.replace(/-/g, '')}@${replyDomain}`;
  const foot = 'Svar blot på denne mail. Vil du ikke høre fra os igen, så svar "afmeld".';
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#1c1917"><div style="white-space:pre-wrap">${esc(message)}</div><p style="margin-top:22px;font-size:12px;color:#78716c">${esc(foot)}</p></div>`;
  try {
    const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject, text: message + '\n\n—\n' + foot, html, reply_to: replyTo }) });
    const t = await r.text();
    if (!r.ok) { console.error('Resend', r.status, t.slice(0, 300)); return { err: 'Resend ' + r.status, status: r.status }; }
    let id = null; try { id = JSON.parse(t).id || null; } catch { /* ignore */ }
    return id ? { id } : { err: 'Resend gav intet id' };
  } catch (e) { console.error(e); return { err: 'Resend kunne ikke nås' }; }
}
