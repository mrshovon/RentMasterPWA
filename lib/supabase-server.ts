import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

// Standard application access configuration client
export const supabaseClient = createClient(supabaseUrl, supabaseAnonKey);

// High-Privilege System Service Access (Bypasses RLS boundaries safely for background routines)
export const supabaseAdminEngine = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
});