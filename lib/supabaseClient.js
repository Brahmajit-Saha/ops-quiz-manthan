import { createClient } from '@supabase/supabase-js';

// One shared browser client. Uses the PUBLISHABLE (anon) key only — never the
// secret/service_role key. All privileged writes go through SECURITY DEFINER
// RPCs in database-setup.sql, so the anon key is safe to ship to the browser.
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

export const supabase = createClient(url, key, {
  realtime: { params: { eventsPerSecond: 10 } },
});

// Small helper: call a Postgres RPC and return its JSON payload (or throw).
export async function rpc(fn, args = {}) {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw error;
  return data;
}
