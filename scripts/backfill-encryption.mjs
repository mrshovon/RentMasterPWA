#!/usr/bin/env node
// =====================================================================================
// Backfill for ADD_FIELD_ENCRYPTION.sql — encrypts the rows that were written before the
// application started encrypting these fields.
//
// This cannot be done in SQL: the key lives in the environment, not in Postgres, so the
// ciphertext has to be produced here and written back.
//
// Usage (from rent-master-pwa/):
//   node scripts/backfill-encryption.mjs --dry-run     # report only, writes nothing
//   node scripts/backfill-encryption.mjs               # do it
//
// Reads NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and FIELD_ENCRYPTION_KEY (or the
// legacy NID_ENCRYPTION_KEY) from .env.local.
//
// SAFE TO RE-RUN. It only touches rows where the plaintext column is non-empty and the encrypted
// column is still null, so a second run is a no-op. It never deletes the plaintext — dropping
// those columns is a separate, deliberate step once this reports zero remaining.
// =====================================================================================

import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DRY_RUN = process.argv.includes('--dry-run');

// Minimal .env.local reader — this script runs outside Next, which is what normally loads it.
for (const file of ['.env.local', '.env']) {
  const full = path.join(ROOT, file);
  if (!fs.existsSync(full)) continue;
  for (const line of fs.readFileSync(full, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RAW_KEY = (process.env.FIELD_ENCRYPTION_KEY || process.env.NID_ENCRYPTION_KEY || '').trim();

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(1);
}
if (!RAW_KEY) {
  console.error('Missing FIELD_ENCRYPTION_KEY (or NID_ENCRYPTION_KEY).');
  process.exit(1);
}

const KEY = /^[0-9a-fA-F]{64}$/.test(RAW_KEY)
  ? Buffer.from(RAW_KEY, 'hex')
  : Buffer.from(RAW_KEY, 'base64');
if (KEY.length !== 32) {
  console.error(`Encryption key must be 32 bytes; got ${KEY.length}.`);
  process.exit(1);
}

// Must produce the exact format lib/field-crypto.ts reads: v1:<iv-b64>:<tag-b64>:<ct-b64>.
function encryptField(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

/**
 * Encrypt one table's plaintext columns into their *_encrypted counterparts.
 * `columns` maps plaintext column -> encrypted column.
 */
async function backfill(table, columns) {
  const plainCols = Object.keys(columns);
  const { data: rows, error } = await db
    .from(table)
    .select(['id', ...plainCols, ...Object.values(columns)].join(', '));
  if (error) throw new Error(`${table}: ${error.message}`);

  const pending = (rows || []).filter((r) =>
    plainCols.some((c) => r[c] && String(r[c]).trim() !== '' && !r[columns[c]]),
  );

  console.log(`${table}: ${rows?.length ?? 0} rows, ${pending.length} need encrypting`);
  if (!pending.length || DRY_RUN) return { total: pending.length, done: 0, failed: 0 };

  let done = 0;
  let failed = 0;
  for (const row of pending) {
    const updates = {};
    for (const plain of plainCols) {
      const value = row[plain];
      if (value && String(value).trim() !== '' && !row[columns[plain]]) {
        updates[columns[plain]] = encryptField(String(value).trim());
      }
    }
    const { error: upErr } = await db.from(table).update(updates).eq('id', row.id);
    if (upErr) {
      failed++;
      console.error(`  ✗ ${table} ${row.id}: ${upErr.message}`);
    } else {
      done++;
    }
  }
  console.log(`  → encrypted ${done}${failed ? `, ${failed} failed` : ''}`);
  return { total: pending.length, done, failed };
}

const results = [];
results.push(await backfill('staff', { nid_number: 'nid_encrypted' }));
results.push(
  await backfill('payment_submissions', {
    sender_msisdn: 'sender_msisdn_encrypted',
    txn_id: 'txn_id_encrypted',
  }),
);

const failed = results.reduce((n, r) => n + r.failed, 0);
if (DRY_RUN) {
  console.log('\nDry run — nothing was written. Re-run without --dry-run to apply.');
} else {
  console.log(`\nDone. ${results.reduce((n, r) => n + r.done, 0)} rows encrypted.`);
  console.log('The plaintext columns are untouched. Drop them once you have verified the app reads');
  console.log('correctly — that is a separate, deliberate step.');
}
process.exit(failed ? 1 : 0);
