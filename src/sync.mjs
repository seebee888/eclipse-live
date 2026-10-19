// The 15-minute job. Opens Content Rewards in headless Chrome with the saved Whop session, pulls each client's
// campaign, writes one password-sealed snapshot per client into dist/, and saves the (possibly refreshed) session.
// GitHub Actions runs it on a schedule (.github/workflows/sync.yml); `npm run sync` runs the same job on a Mac.
//
// Exit codes: 0 ok, 2 the Whop session is signed out (run `npm run login`), 1 anything else.
import { chromium } from 'playwright-core';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { masterKey, passwordKey, seal, unseal, PBKDF2_ITER } from './crypto.mjs';
import { buildSnapshot, verifiedRows, IN_CAMPAIGN } from './metrics.mjs';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const STATE_FILE = join(ROOT, '.state.enc');
const DIST = join(ROOT, 'dist');
const HOUR = 3600e3;
const iso = t => new Date(t).toISOString();

export class SignedOut extends Error {}

export async function loadConfig(key) {
  return unseal(key, JSON.parse(readFileSync(join(ROOT, 'config', 'config.enc'), 'utf8')));
}

export async function launchChrome({ headless = true } = {}) {
  return chromium.launch({
    channel: 'chrome', headless,
    args: ['--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
  });
}

export const launchUrl = cfg => `https://whop.com/core/app/launch/?redirect=${encodeURIComponent(`https://${cfg.appHost}/b`)}`;

// Lands a tab on the business side of Content Rewards, signed in, or throws SignedOut. Signed out, Whop's launch link
// still reaches the app but bounces to its public homepage, and public endpoints (the campaign list) still answer 200,
// so the test is the business route plus a submissions read.
export async function openContentRewards(context, cfg, { timeout = 45000, page = null } = {}) {
  page ||= await context.newPage();
  await page.goto(launchUrl(cfg), { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForURL(u => u.hostname === cfg.appHost && u.pathname.startsWith('/b'), { timeout }).catch(() => {});
  const u = new URL(page.url());
  if (u.hostname !== cfg.appHost || !u.pathname.startsWith('/b')) throw new SignedOut('Whop opened Content Rewards signed out');
  const status = await page.evaluate(async cid => (await fetch(`/api/submission/submissions?campaignIds=${cid}&limit=1`,
    { credentials: 'include', cache: 'no-store' })).status, cfg.clients[0].campaignId);
  if (status !== 200) throw new SignedOut(`Content Rewards answered ${status}`);
  return page;
}

// Keeps what the charts need between runs: the clean hourly curve, points added since, and verified clips' views
// once an hour for the last 30 hours ("still climbing").
function updateHistory(h, pulled, cfg, now) {
  if (pulled.curve) { h.curve = pulled.curve; h.curveAt = iso(now); h.points = []; }
  h.points ||= [];
  h.status = pulled.campaign.status;
  const total = pulled.rows.reduce((a, r) => a + (IN_CAMPAIGN.has(r.st) ? r.v : 0), 0);
  const last = h.points.at(-1)?.[0] || h.curve?.at(-1)?.[0];
  if (!last || now - Date.parse(last) >= 10 * 60e3) h.points.push([iso(now), total]);
  // keep 15-minute points for two days, one per hour before that
  const seen = new Set();
  h.points = h.points.filter(([t]) => {
    if (now - Date.parse(t) < 48 * HOUR) return true;
    const hk = t.slice(0, 13);
    return seen.has(hk) ? false : seen.add(hk);
  });
  h.rows ||= {};
  const hk = iso(Math.floor(now / HOUR) * HOUR);
  if (!h.rows[hk]) h.rows[hk] = Object.fromEntries(verifiedRows(cfg, pulled.rows).map(r => [r.id.slice(0, 8), r.v]));
  for (const k of Object.keys(h.rows)) if (now - Date.parse(k) > 30 * HOUR) delete h.rows[k];
}

export function buildSite(clients) {
  rmSync(DIST, { recursive: true, force: true });
  cpSync(join(ROOT, 'site'), DIST, { recursive: true });
  const app = readFileSync(join(ROOT, 'site', 'app.html'), 'utf8');
  for (const c of clients) {
    mkdirSync(join(DIST, c.slug), { recursive: true });
    writeFileSync(join(DIST, c.slug, 'index.html'),
      app.replace('<!--DATA-->', `<meta name="eclipse-data" content="../d/${c.fileId}.json">`));
    // installable as an app; generic name, since this file is public
    writeFileSync(join(DIST, c.slug, 'manifest.webmanifest'), JSON.stringify({
      name: 'Eclipse Live', short_name: 'Eclipse', start_url: './', scope: './', display: 'standalone',
      background_color: '#ffffff', theme_color: '#ffffff',
      icons: [{ src: '../assets/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '../assets/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }],
    }));
  }
  rmSync(join(DIST, 'app.html'));
  mkdirSync(join(DIST, 'd'), { recursive: true });
}

// One PBKDF2 per client per run: the snapshot and the key art are sealed with the same key.
const keys = new Map();
const clientKey = (c, id = `${c.salt} ${c.password}`) => keys.get(id) || keys.set(id, passwordKey(c.password, c.salt)).get(id);

// A client's key art: a data: URL once `npm run config` has sealed it into config.enc, or a file under config/
// (gitignored) when the config comes straight from clients.local.json.
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
export function artSrc(art) {
  if (art.startsWith('data:')) return art;
  return `data:${MIME[extname(art).toLowerCase()] || 'image/jpeg'};base64,${readFileSync(join(ROOT, 'config', art)).toString('base64')}`;
}

// The key art goes out sealed like the numbers, into dist/d/<fileId>.art.json: the picture alone would say whose
// dashboard it is.
export async function writeArt(c) {
  if (!c.art) return;
  writeFileSync(join(DIST, 'd', `${c.fileId}.art.json`), JSON.stringify(await seal(await clientKey(c), { src: artSrc(c.art) })));
}

// One client's sealed snapshot into dist/d/<fileId>.json.
export async function writeClient(c, pulled, h, now) {
  updateHistory(h, pulled, c, now);
  const snap = buildSnapshot({
    cfg: c, campaign: pulled.campaign, rows: pulled.rows, now, dataAsOf: pulled.dataAsOf,
    curve: [...(h.curve || []), ...h.points].sort((a, b) => a[0].localeCompare(b[0])), rowHistory: h.rows,
  });
  const box = await seal(await clientKey(c), snap,
    { t: snap.generatedAt, kdf: { alg: 'PBKDF2-SHA256', iter: PBKDF2_ITER, salt: c.salt } });
  writeFileSync(join(DIST, 'd', `${c.fileId}.json`), JSON.stringify(box));
  return snap;
}

export async function sync({ log = console.log } = {}) {
  const key = await masterKey();
  const cfg = await loadConfig(key);
  const state = existsSync(STATE_FILE) ? await unseal(key, JSON.parse(readFileSync(STATE_FILE, 'utf8'))) : {};
  if (!state.storage) throw new SignedOut('No Whop session saved yet');
  state.history ||= {};

  buildSite(cfg.clients);
  const browser = await launchChrome();
  let failed = 0;
  try {
    const context = await browser.newContext({
      storageState: state.storage, userAgent: state.userAgent, viewport: { width: 1280, height: 900 },
    });
    const page = await openContentRewards(context, cfg);
    await page.evaluate(readFileSync(join(ROOT, 'src', 'pull.js'), 'utf8'));
    for (const [i, c] of cfg.clients.entries()) {
      const label = `client ${i + 1}/${cfg.clients.length}`;   // public logs: no names
      await writeArt(c).catch(e => log(`${label}: key art skipped (${e.message?.split('\n')[0]})`));
      try {
        const h = (state.history[c.campaignId] ||= {});
        const stale = !h.curveAt || (h.status === 'active' && Date.now() - Date.parse(h.curveAt) > 24 * HOUR);
        const t0 = Date.now();
        const pulled = await page.evaluate(([cid, curve]) => window.__eclipsePull(cid, { curve }), [c.campaignId, stale]);
        await writeClient(c, pulled, h, Date.now());
        log(`${label}: ok, ${pulled.rows.length} rows${stale ? ', curve rebuilt' : ''}, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
      } catch (e) {
        if (e.message?.includes('signed out')) throw new SignedOut(e.message);
        failed++;
        log(`${label}: failed (${e.message?.split('\n')[0]}), keeping the last published data`);
        const prev = cfg.siteUrl && await fetch(`${cfg.siteUrl}/d/${c.fileId}.json?x=${Date.now()}`).catch(() => null);
        if (prev?.ok) writeFileSync(join(DIST, 'd', `${c.fileId}.json`), await prev.text());
      }
    }
    state.storage = await context.storageState();
  } finally {
    await browser.close();
  }
  writeFileSync(STATE_FILE, JSON.stringify(await seal(key, state)));
  writeFileSync(join(DIST, 'status.json'), JSON.stringify({ ok: failed === 0, at: iso(Date.now()), failed }));
  return { failed, total: cfg.clients.length };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  // A campaign that fails keeps its last published numbers and the rest still publish; only a run where every
  // campaign failed (or Whop signed out) fails the job, which is what makes GitHub email the repo owner.
  sync().then(({ failed, total }) => {
    if (failed) console.log(`::warning::${failed} of ${total} campaign(s) kept their last published numbers this run`);
    process.exit(failed && failed === total ? 1 : 0);
  }, e => {
    if (e instanceof SignedOut) {
      console.error(`::error::Whop session signed out (${e.message}). On the Mac: cd eclipse-live && npm run login`);
      process.exit(2);
    }
    console.error(e.stack || e);
    process.exit(1);
  });
}
