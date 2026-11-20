// Runs in .github/workflows/handoff.yml. Takes a Whop session that `npm run handoff` sealed with a one-time key
// (secret ECLIPSE_HANDOFF, blob on the `handoff` branch), proves it opens Content Rewards headless from GitHub's
// machines with the real config, and re-seals it with the master key as the session the 15-minute job uses.
// This is how a Mac without the master key signs Whop back in. Logs carry no names or numbers.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { masterKey, seal, unseal } from '../src/crypto.mjs';
import { ROOT, STATE_FILE, launchChrome, loadConfig, openContentRewards } from '../src/sync.mjs';

const HANDOFF = join(ROOT, '.handoff.enc');
const raw = (process.env.ECLIPSE_HANDOFF || '').trim();
if (!raw) throw new Error('No ECLIPSE_HANDOFF secret. Run npm run handoff on the Mac.');
if (!existsSync(HANDOFF)) throw new Error('No handoff waiting on the handoff branch. Run npm run handoff on the Mac.');

const once = await globalThis.crypto.subtle.importKey('raw', Buffer.from(raw, 'base64'), 'AES-GCM', false, ['decrypt']);
const given = await unseal(once, JSON.parse(readFileSync(HANDOFF, 'utf8')));
const key = await masterKey();
const cfg = await loadConfig(key);

const browser = await launchChrome();
try {
  const ctx = await browser.newContext({ storageState: given.storage, userAgent: given.userAgent, viewport: { width: 1280, height: 900 } });
  await openContentRewards(ctx, cfg);
  given.storage = await ctx.storageState();
} finally { await browser.close(); }

const old = existsSync(STATE_FILE) ? await unseal(key, JSON.parse(readFileSync(STATE_FILE, 'utf8'))).catch(() => ({})) : {};
writeFileSync(STATE_FILE, JSON.stringify(await seal(key, { ...old, storage: given.storage, userAgent: given.userAgent, loginAt: given.loginAt })));
console.log('Handed-off session opens Content Rewards here. Saved as the sync session.');
