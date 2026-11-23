// Netlify Function: send-mail  (kalder Resend – nøglen ligger kun på serveren)
// Handlinger:  test (sender til dig selv) · invite (invitation på medarbejderens sprog) · report (PDF/CSV til bygherre m.fl.)
// Miljøvariabler i Netlify:
//   RESEND_API_KEY, RESEND_FROM_EMAIL   (f.eks.  UniSjak <noreply@unisjak.dk>)
//   SUPABASE_URL, SUPABASE_ANON_KEY     (samme værdier som i appen – bruges til at kontrollere, hvem der kalder)
//   SITE_URL                            (valgfri, standard https://unisjak.dk)
// Kun indloggede, aktive admins/formænd kan sende. Invitationer kan kun sendes til en e-mail, der har en åben invitation i firmaet.

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const EMAIL = /^[^@\s<>",;]+@[^@\s<>",;]+\.[^@\s<>",;]+$/;
const LANGS = ['da', 'en', 'cs', 'pl'];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clean = (s, n) => String(s ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, n);

// Enkel begrænsning pr. bruger (pr. kørende instans – et ekstra værn ud over Resends egne grænser)
const hits = new Map();
function limited(uid, max = 40) {
  const now = Date.now(), arr = (hits.get(uid) || []).filter(t => now - t < 3600_000);
  if (arr.length >= max) { hits.set(uid, arr); return true; }
  arr.push(now); hits.set(uid, arr); return false;
}

const T = {
  da: { subj: (c) => `Du er inviteret til ${c} i UniSjak`, hi: n => `Hej ${n},`, body: (w, c) => `${w} har inviteret dig til ${c} i UniSjak – appen til timer, vagter, planlægning og opgaver.`, how: e => `Opret en konto med præcis denne e-mail: ${e}. Så kommer du automatisk ind i virksomheden.`, btn: 'Opret konto', foot: 'Hvis du ikke forventede denne mail, kan du blot ignorere den.', tsubj: 'Testmail fra UniSjak', tbody: 'Din mailopsætning virker. Invitationer og rapporter sendes fra denne adresse.' },
  en: { subj: (c) => `You're invited to ${c} on UniSjak`, hi: n => `Hi ${n},`, body: (w, c) => `${w} has invited you to ${c} on UniSjak – the app for hours, shifts, planning and tasks.`, how: e => `Create an account with exactly this e-mail: ${e}. You will then join the company automatically.`, btn: 'Create account', foot: "If you weren't expecting this e-mail, you can simply ignore it.", tsubj: 'Test e-mail from UniSjak', tbody: 'Your e-mail setup works. Invitations and reports are sent from this address.' },
  cs: { subj: (c) => `Pozvánka do ${c} v UniSjak`, hi: n => `Ahoj ${n},`, body: (w, c) => `${w} vás pozval(a) do ${c} v aplikaci UniSjak – pro hodiny, směny, plánování a úkoly.`, how: e => `Vytvořte si účet přesně s tímto e-mailem: ${e}. Poté se automaticky připojíte k firmě.`, btn: 'Vytvořit účet', foot: 'Pokud jste tento e-mail nečekali, jednoduše ho ignorujte.', tsubj: 'Testovací e-mail z UniSjak', tbody: 'Nastavení e-mailu funguje. Pozvánky a zprávy se odesílají z této adresy.' },
  pl: { subj: (c) => `Zaproszenie do ${c} w UniSjak`, hi: n => `Cześć ${n},`, body: (w, c) => `${w} zaprasza Cię do ${c} w aplikacji UniSjak – do godzin pracy, zmian, planowania i zadań.`, how: e => `Załóż konto dokładnie z tym adresem e-mail: ${e}. Wtedy automatycznie dołączysz do firmy.`, btn: 'Załóż konto', foot: 'Jeśli nie spodziewałeś(aś) się tej wiadomości, po prostu ją zignoruj.', tsubj: 'Testowa wiadomość z UniSjak', tbody: 'Konfiguracja poczty działa. Zaproszenia i raporty są wysyłane z tego adresu.' },
};

function shell(inner, siteUrl) {
  return `<!doctype html><html><body style="margin:0;background:#f4f4f2;font-family:Arial,Helvetica,sans-serif;color:#1c1917"><div style="max-width:520px;margin:0 auto;padding:24px"><div style="background:#fff;border-radius:14px;padding:28px;border:1px solid #e7e5e4"><div style="font-size:22px;font-weight:800;margin-bottom:18px">Uni<span style="color:#ea580c">Sjak</span></div>${inner}</div><p style="font-size:11px;color:#78716c;text-align:center;margin-top:14px">UniSjak · <a href="${esc(siteUrl)}" style="color:#78716c">${esc(siteUrl.replace(/^https?:\/\//, ''))}</a></p></div></body></html>`;
}
const btnHtml = (href, label) => `<p style="margin:22px 0"><a href="${esc(href)}" style="background:#ea580c;color:#fff;text-decoration:none;font-weight:800;padding:14px 22px;border-radius:10px;display:inline-block">${esc(label)}</a></p>`;

async function resend(env, payload) {
  const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: env.RESEND_FROM_EMAIL, ...payload }) });
  if (!r.ok) { let d = ''; try { d = (await r.text()).slice(0, 300); } catch { /* ignore */ } console.error('Resend', r.status, d); return false; }
  return true;
}

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  const env = process.env;
  if (!env.RESEND_API_KEY || !env.RESEND_FROM_EMAIL || !env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return json({ error: 'not configured' }, 500);
  const siteUrl = (env.SITE_URL || 'https://unisjak.dk').replace(/\/+$/, '');
  const base = env.SUPABASE_URL.replace(/\/+$/, '');

  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return json({ error: 'unauthorized' }, 401);
  const H = { apikey: env.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + token };
  let user;
  try { const r = await fetch(base + '/auth/v1/user', { headers: H }); if (!r.ok) return json({ error: 'unauthorized' }, 401); user = await r.json(); } catch { return json({ error: 'auth' }, 502); }
  if (!user?.id || !user.email) return json({ error: 'unauthorized' }, 401);

  const rest = async (path) => { const r = await fetch(base + '/rest/v1/' + path, { headers: H }); if (!r.ok) return null; return r.json(); };
  const prof = (await rest(`profiles?id=eq.${encodeURIComponent(user.id)}&select=role,active,company_id,full_name`))?.[0];
  if (!prof || !prof.active || !['admin', 'formand'].includes(prof.role)) return json({ error: 'forbidden' }, 403);
  if (limited(user.id)) return json({ error: 'limit' }, 429);

  let b; try { b = await req.json(); } catch { return json({ error: 'json' }, 400); }
  const lang = LANGS.includes(b.lang) ? b.lang : 'da', t = T[lang];
  const who = clean(prof.full_name, 80) || 'UniSjak';

  try {
    if (b.action === 'test') {
      const html = shell(`<p style="font-size:15px">${esc(t.tbody)}</p>`, siteUrl);
      const ok = await resend(env, { to: [user.email], subject: t.tsubj, text: t.tbody, html });
      return ok ? json({ ok: true, to: user.email }) : json({ error: 'upstream' }, 502);
    }

    if (b.action === 'invite') {
      const email = clean(b.email, 120).toLowerCase();
      if (!EMAIL.test(email)) return json({ error: 'to' }, 400);
      const inv = (await rest(`invitations?email=eq.${encodeURIComponent(email)}&accepted_at=is.null&company_id=eq.${encodeURIComponent(prof.company_id)}&select=full_name,role,expires_at`))?.[0];
      if (!inv || new Date(inv.expires_at) < new Date()) return json({ error: 'no invitation' }, 404);
      const co = (await rest(`companies?id=eq.${encodeURIComponent(prof.company_id)}&select=name`))?.[0];
      const company = clean(co?.name, 80) || 'UniSjak';
      const name = clean(inv.full_name, 80);
      const text = `${t.hi(name)}\n\n${t.body(who, company)}\n\n${t.how(email)}\n${siteUrl}\n\n${t.foot}`;
      const html = shell(`<p style="font-size:16px;font-weight:700">${esc(t.hi(name))}</p><p style="font-size:15px;line-height:1.5">${esc(t.body(who, company))}</p><p style="font-size:15px;line-height:1.5">${esc(t.how(email))}</p>${btnHtml(siteUrl, t.btn)}<p style="font-size:12px;color:#78716c">${esc(t.foot)}</p>`, siteUrl);
      const ok = await resend(env, { to: [email], subject: t.subj(company), text, html, reply_to: user.email });
      return ok ? json({ ok: true }) : json({ error: 'upstream' }, 502);
    }

    if (b.action === 'report') {
      const to = clean(b.to, 120).toLowerCase();
      const subject = clean(b.subject, 150), message = String(b.message || '').slice(0, 2000);
      const filename = String(b.filename || '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
      const mime = String(b.mime || ''), content = String(b.content_base64 || '');
      if (!EMAIL.test(to)) return json({ error: 'to' }, 400);
      if (!subject || !filename) return json({ error: 'input' }, 400);
      if (!['application/pdf', 'text/csv'].includes(mime)) return json({ error: 'mime' }, 400);
      if (!/^[A-Za-z0-9+/=]+$/.test(content) || content.length < 20 || content.length > 6_000_000) return json({ error: 'size' }, 400);
      const co = (await rest(`companies?id=eq.${encodeURIComponent(prof.company_id)}&select=name`))?.[0];
      const sig = `—\nSendt fra UniSjak af ${who}${co?.name ? ' (' + clean(co.name, 80) + ')' : ''}.`;
      const text = (message ? message + '\n\n' : '') + sig;
      const html = shell(`${message ? `<p style="font-size:15px;line-height:1.5;white-space:pre-wrap">${esc(message)}</p>` : ''}<p style="font-size:13px;color:#78716c">${esc(sig.replace('—\n', ''))}</p>`, siteUrl);
      const ok = await resend(env, { to: [to], subject, text, html, reply_to: user.email, attachments: [{ filename, content }] });
      return ok ? json({ ok: true }) : json({ error: 'upstream' }, 502);
    }
    return json({ error: 'action' }, 400);
  } catch (e) { console.error(e); return json({ error: 'failed' }, 502); }
};
