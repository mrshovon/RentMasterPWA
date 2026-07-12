import { supabaseAdminEngine } from './supabase-server';

/**
 * Validates request Bearer Authorization tokens and decodes custom access boundaries
 */
export async function authenticateAndVerifyRole(authHeaderValue: string | null) {
  // 1. Check if the Authorization header exists and follows the 'Bearer <token>' pattern
  if (!authHeaderValue || !authHeaderValue.startsWith('Bearer ')) {
    return { error: 'Authorization header payload format missing or illegal.', session: null };
  }

  const token = authHeaderValue.split(' ')[1];

  // 2. Intercept and validate token against Supabase Core Auth Server
  const { data: { user }, error: tokenValidationError } = await supabaseAdminEngine.auth.getUser(token);

  if (tokenValidationError || !user) {
    return { error: 'Invalid user access token or session expired.', session: null };
  }

  // 3. Fetch user profile from the public schema to verify role metrics authorization
  const { data: profile, error: profileFetchError } = await supabaseAdminEngine
    .from('user_profiles')
    .select('role, name, phone')
    .eq('id', user.id)
    .single();

  if (profileFetchError || !profile) {
    return { error: 'User profile mapping synchronization error inside identity schema.', session: null };
  }

  // 4. Return decoded operational claims parameters safely downstream
  return {
    error: null,
    session: {
      uid: user.id,
      email: user.email,
      role: profile.role, // 'super_admin' | 'owner' | 'tenant'
      name: profile.name,
      phone: profile.phone
    }
  };
}