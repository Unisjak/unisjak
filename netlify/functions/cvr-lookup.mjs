// Netlify Function: cvr-lookup  (superadmin slår en virksomhed op i CVR via cvrapi.dk på navn eller CVR-nummer)
// POST { q: "Munck Havne" | "12345678" }  ->  { ok:true, firm:{ cvr, name, address, zip, city, phone, email, employees, industry, started, active } }
// Kun en indlogget, aktiv superadmin må kalde den. Kun åbne virksomhedsdata (ingen personer).
import { json, requireSuperadmin } from './_lib/crm-auth.mjs';

const hits = new Map();
function limited(uid, max = 40) {
  const now = Date.now(), arr = (hits.get(uid) || []).filter(t => now - t < 3600_000);
  if (arr.length >= max) { hits.set(uid, arr); return true; }
  arr.push(now); hits.set(uid, arr); return false;
}
const clean = (s, n = 200) => String(s ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, n);

export function mapFirm(d) {
  if (!d || d.error || !d.vat) return null;
  return {
    cvr: String(d.vat).padStart(8, '0'), name: clean(d.name), address: clean(d.address), zip: clean(d.zipcode, 10), city: clean(d.city, 80),
    phone: clean(d.phone, 40), email: clean(d.email, 320), employees: d.employees != null ? clean(d.employees, 40) : '',
    industry: clean(d.industrydesc, 120), started: clean(d.startdate, 20), active: !d.enddate
  };
}

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  const env = process.env;
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return json({ error: 'not configured' }, 500);
  const auth = await requireSuperadmin(req, env); if (auth.err) return auth.err;
  if (limited(auth.user.id)) return json({ error: 'limit' }, 429);
  let b; try { b = await req.json(); } catch { return json({ error: 'json' }, 400); }
  const q = clean(b.q, 120); if (q.length < 2) return json({ error: 'q' }, 400);
  let d;
  try {
    const r = await fetch('https://cvrapi.dk/api?country=dk&format=json&search=' + encodeURIComponent(q), { headers: { 'User-Agent': 'UniSjak Kontrolcenter (morten@unisjak.dk)', Accept: 'application/json' } });
    if (r.status === 429) return json({ error: 'limit' }, 429);
    d = await r.json();
  } catch { return json({ error: 'upstream' }, 502); }
  if (d && d.error === 'NOT_FOUND') return json({ ok: true, firm: null });
  const firm = mapFirm(d);
  return json(firm ? { ok: true, firm } : { error: 'upstream' }, firm ? 200 : 502);
};
