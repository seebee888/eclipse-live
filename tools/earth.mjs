// Builds site/assets/earth.json, the map the hero's globe is drawn from: a Fibonacci lattice of points over the sphere,
// each tagged with the country it falls in (0 for sea), plus a center for every country to turn the globe to.
// The page rebuilds the same lattice from `n`, so only the tags ship.
//
// It's run once, not by the sync. From an empty folder:
//   npm install --ignore-scripts d3-geo@3 topojson-client@3 world-atlas@2 i18n-iso-countries@7
//   node <repo>/tools/earth.mjs <that folder>/node_modules <repo>/site/assets/earth.json
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [mods, out] = process.argv.slice(2);
if (!mods || !out) { console.error('usage: node tools/earth.mjs <node_modules> <out.json>'); process.exit(1); }
const geo = await import(pathToFileURL(join(mods, 'd3-geo/src/index.js')).href);
const topo = await import(pathToFileURL(join(mods, 'topojson-client/src/index.js')).href);
const world = JSON.parse(readFileSync(join(mods, 'world-atlas/countries-50m.json'), 'utf8'));
const iso = JSON.parse(readFileSync(join(mods, 'i18n-iso-countries/codes.json'), 'utf8'));
const alpha2 = Object.fromEntries(iso.map(([a2, , num]) => [num, a2]));

const N = 60000, GA = Math.PI * (3 - Math.sqrt(5)), DEG = 180 / Math.PI;
const features = topo.feature(world, world.objects.countries).features;
// some countries come in more than one feature (Australia and its Ashmore Islands), so features share a code's index
const codes = [], centers = {}, best = {};
const area = g => { const a = geo.geoArea(g); return Math.min(a, 4 * Math.PI - a); };
const shapes = features.map((f, i) => {
  const code = alpha2[f.id] || 'X' + i;   // a few disputed areas have no ISO code: still land, never a market
  if (!codes.includes(code)) codes.push(code);
  // the center of the largest piece, so Alaska and Hawaii don't pull the United States out to sea
  const polys = f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates : [f.geometry.coordinates];
  for (const c of polys) {
    const g = { type: 'Polygon', coordinates: c }, a = area(g);
    if (!(a <= best[code])) {
      best[code] = a;
      const [lon, lat] = geo.geoCentroid(g);
      centers[code] = [+lat.toFixed(2), +lon.toFixed(2)];
    }
  }
  return { f, b: geo.geoBounds(f), k: codes.indexOf(code) + 1 };
});
const inBox = ([lon, lat], [[w, s], [e, n]]) => lat >= s - .5 && lat <= n + .5 && (w <= e ? lon >= w - .5 && lon <= e + .5 : lon >= w - .5 || lon <= e + .5);

const cells = new Uint8Array(N);
let land = 0;
for (let i = 0; i < N; i++) {
  const y = 1 - (2 * i + 1) / N, r = Math.sqrt(1 - y * y), th = i * GA;
  const pt = [Math.atan2(r * Math.sin(th), r * Math.cos(th)) * DEG, Math.asin(y) * DEG];
  const hit = shapes.find(s => inBox(pt, s.b) && geo.geoContains(s.f, pt));
  if (hit) { cells[i] = hit.k; land++; }
}
if (codes.length > 255) throw new Error('more than 255 countries');
writeFileSync(out, JSON.stringify({ n: N, codes, centers, cells: Buffer.from(cells).toString('base64') }));
console.log(`${land} land points of ${N}, ${codes.length} countries -> ${out}`);
