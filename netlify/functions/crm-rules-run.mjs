// Netlify Function (planlagt hver time): kører CRM-reglerne, som lægger udkast i godkendelseskøen. Sender aldrig noget selv.
import { serviceRpc } from './_lib/crm-auth.mjs';
export default async () => {
  const env = process.env;
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) { console.error('crm-rules-run: ikke konfigureret'); return; }
  const r = await serviceRpc(env)('crm_run_rules', {});
  console.log('crm-rules-run', r.ok ? 'oprettede ' + r.data + ' udkast' : 'fejl ' + r.status + ' ' + r.text.slice(0, 200));
};
export const config = { schedule: '@hourly' };
