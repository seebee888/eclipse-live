// AES-256-GCM boxes for everything the public repo and site hold. The config and the Whop browser session are
// sealed with the master key (GitHub secret ECLIPSE_KEY, and ~/.eclipse-live/key on the Mac that set it up).
// Each client's dashboard data is sealed with a key derived from that client's password, so the published
// site holds nothing readable without it. site/index.html opens the same box format in the browser.
import { gzipSync, gunzipSync } from 'node:zlib';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const KEY_FILE = join(homedir(), '.eclipse-live', 'key');
export const PBKDF2_ITER = 600000;
const { subtle } = globalThis.crypto;
const b64 = b => Buffer.from(b).toString('base64');
const unb64 = s => Buffer.from(s, 'base64');

export async function masterKey() {
  const s = (process.env.ECLIPSE_KEY || (existsSync(KEY_FILE) ? readFileSync(KEY_FILE, 'utf8') : '')).trim();
  if (!s) throw new Error('No master key. Run `node src/cli.mjs init` on the Mac that manages the dashboards.');
  return subtle.importKey('raw', unb64(s), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function passwordKey(password, salt, iterations = PBKDF2_ITER) {
  const base = await subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: unb64(salt), iterations },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

// value -> JSON -> gzip -> AES-GCM. `header` rides along in the clear (timestamps, KDF parameters).
export async function seal(key, value, header = {}) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, key, gzipSync(Buffer.from(JSON.stringify(value))));
  return { v: 1, ...header, iv: b64(iv), ct: b64(ct) };
}

export async function unseal(key, box) {
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.iv) }, key, unb64(box.ct));
  return JSON.parse(gunzipSync(Buffer.from(pt)).toString());
}
