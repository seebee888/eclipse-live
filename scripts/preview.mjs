// Builds dist/ from a saved pull ({<key>: {campaign, rows, curve, dataAsOf}}) instead of a live browser session, for
// checking the page locally. Usage: node scripts/preview.mjs <pull.json> <slug>=<pull key> …
import { readFileSync } from 'node:fs';
import { buildSite, writeArt, writeClient } from '../src/sync.mjs';

const [file, ...pairs] = process.argv.slice(2);
const pull = JSON.parse(readFileSync(file, 'utf8'));
const cfg = JSON.parse(readFileSync(new URL('../config/clients.local.json', import.meta.url), 'utf8'));
buildSite(cfg.clients);
for (const pair of pairs) {
  const [slug, key] = pair.split('=');
  const c = cfg.clients.find(x => x.slug === slug);
  await writeArt(c);
  const snap = await writeClient(c, pull[key], {}, Date.now());
  console.log(`${slug}: ${snap.kpis.totalViews.toLocaleString()} total views -> dist/${slug}/`);
}
