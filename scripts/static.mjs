// Publishes the site without pulling Content Rewards: the page, the static pages under site/ (the sample dashboard),
// and every client dashboard that already has published numbers, carried over as they are. Used by
// .github/workflows/site.yml when only the site changed, or while the Whop session is signed out.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { masterKey } from '../src/crypto.mjs';
import { loadConfig, buildSite, writeArt, ROOT } from '../src/sync.mjs';

const cfg = await loadConfig(await masterKey());
const kept = [];
for (const c of cfg.clients) {
  const r = cfg.siteUrl && await fetch(`${cfg.siteUrl}/d/${c.fileId}.json?x=${Date.now()}`).catch(() => null);
  if (r?.ok) kept.push([c, await r.text()]);
}
buildSite(kept.map(([c]) => c));   // a client with nothing published yet gets no page, not an empty one
for (const [i, [c, box]] of kept.entries()) {
  writeFileSync(join(ROOT, 'dist', 'd', `${c.fileId}.json`), box);
  await writeArt(c).catch(() => console.log(`client ${i + 1}: key art skipped`));
}
console.log(`site built, ${kept.length} of ${cfg.clients.length} client dashboard(s) carried over`);
