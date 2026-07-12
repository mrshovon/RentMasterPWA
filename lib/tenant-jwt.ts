// Minimal HS256 JWT for tenants (who are NOT Supabase auth users). Uses Web Crypto
// so it runs in both the Edge middleware and Node route handlers — no dependency.
// Signed with the service-role key as the HMAC secret (server-only; never sent to clients).

const enc = new TextEncoder();

function secret(): string {
  // Fail closed: never fall back to a hardcoded/guessable secret (that would allow
  // tenant-token forgery). Require an explicitly configured secret.
  const s = process.env.TENANT_JWT_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!s) throw new Error('Tenant JWT secret is not configured (set TENANT_JWT_SECRET or SUPABASE_SERVICE_ROLE_KEY).');
  return s;
}

function b64url(input: Uint8Array | string): string {
  const bytes = typeof input === 'string' ? enc.encode(input) : input;
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s: string): Uint8Array {
  let t = s.replace(/-/g, '+').replace(/_/g, '/');
  while (t.length % 4) t += '=';
  const bin = atob(t);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret()), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function signTenantToken(tenantId: string, name?: string | null, ttlSeconds = 60 * 60 * 24 * 7): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ sub: tenantId, type: 'tenant', name: name ?? null, iat: now, exp: now + ttlSeconds }));
  const data = `${header}.${payload}`;
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(), enc.encode(data));
  return `${data}.${b64url(new Uint8Array(sig))}`;
}

export async function verifyTenantToken(token: string): Promise<{ tenantId: string; name: string | null } | null> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [h, p, s] = parts;
    const valid = await crypto.subtle.verify('HMAC', await hmacKey(), fromB64url(s) as BufferSource, enc.encode(`${h}.${p}`));
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(fromB64url(p)));
    if (payload.type !== 'tenant' || !payload.sub) return null;
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return { tenantId: payload.sub, name: payload.name ?? null };
  } catch {
    return null;
  }
}
