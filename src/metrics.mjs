// Turns one Content Rewards pull into the snapshot a client's dashboard shows. Pure (no I/O), so the 15-minute
// sync runs it in Node and a spot check can run the same code in a browser tab against the live app.
//
// What each number means (kept in line with the Phase reports; README has the history):
// - Total views:    views on every clip still in the campaign (any status except rejected), Content Rewards counts.
// - Verified views: approved clips + clips Eclipse's review cleared (cfg.cleared), only while the post is still up.
// - Clips posted:   clips still in the campaign.
// - Creators:       distinct creators behind those clips.
// - Engagement:     (likes + comments + shares + saves) / views over the verified clips. Shares and saves come from
//                   each creator's Instagram Insights recording, scaled to the clip's views now; a clip without a
//                   recording adds Content Rewards' share count (0 on Instagram), so the rate never overstates.
// Nothing internal leaves this file: no budgets, payouts, review statuses, creator names or ids.

const n = v => Number(v || 0);
export const IN_CAMPAIGN = new Set(['approved', 'review_required', 'tracking', 'overdue']);
const DAY = 86400e3;
const HOUR = 3600e3;

// Rows arrive compacted by src/pull.js: {id, st, p, v, l, c, sh, at, url, th, ti, u, del, vo}.

export function postCode(url) {
  const m = /\/(?:reels?|p)\/([A-Za-z0-9_-]+)/.exec(url || '') || /\/video\/(\d+)/.exec(url || '');
  return m ? m[1] : null;
}

// First caption line without links, emoji or the trailing hashtag pile, cut at a word boundary. A hashtag inside
// the sentence becomes words ("Watch #JaneDoe’s special" -> "Watch Jane Doe’s special"); mentions go.
const TAG = /[#@][\p{L}\p{N}_.]+/u;
export function cleanTitle(caption, max = 58) {
  let s = String(caption || '').split('\n').map(x => x.trim())
    .find(x => x.replace(new RegExp(TAG.source, 'gu'), '').replace(/\p{Extended_Pictographic}/gu, '').trim()) || '';
  s = s.replace(/https?:\/\/\S+/g, '')
    .replace(/\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}️‍⃣]/gu, '')
    .replace(new RegExp(`(\\s*${TAG.source})+\\s*$`, 'u'), '')
    .replace(/#([\p{L}\p{N}_]+)/gu, (_, w) => w.replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2'))
    .replace(/@[\p{L}\p{N}_.]+/gu, '').replace(/["“”„]/g, '')
    .replace(/\s+/g, ' ').replace(/^[\s"“”„'‘’.,:;|•-]+|[\s"“”„'‘’,:;|•-]+$/g, '').trim();
  if (!s) return null;
  if (s.length > max) s = s.slice(0, max).replace(/\s+\S*$/, '') + '…';
  return s[0].toUpperCase() + s.slice(1);
}

const COUNTRY = { US: 'United States', CA: 'Canada', UK: 'United Kingdom', GB: 'United Kingdom', AU: 'Australia',
  IE: 'Ireland', NZ: 'New Zealand', IN: 'India', PH: 'Philippines', DE: 'Germany', BR: 'Brazil' };

// The cumulative clean-views curve ([[isoTime, views], ...], oldest first) at or just before time t.
function curveAt(curve, t, tolerance = 2 * 3600e3) {
  let best = null;
  for (const [iso, v] of curve) {
    const ti = Date.parse(iso);
    if (ti <= t) best = [ti, v]; else break;
  }
  return best && t - best[0] <= tolerance ? best[1] : null;
}

// Views gained in each of the last `hours` clock hours (the last one still running), for the live pulse.
// Null until the curve reaches back a day.
function pulse(curve, now, hours = 48) {
  if (!curve.length || Date.parse(curve[0][0]) > now - DAY) return null;
  const at = t => curveAt(curve, t, Infinity);
  const end = Math.floor(now / HOUR) * HOUR;
  const out = [];
  for (let t = end - (hours - 1) * HOUR; t <= end; t += HOUR) {
    const a = at(t), b = at(Math.min(t + HOUR, now));
    out.push({ t: new Date(t).toISOString(), g: a == null || b == null ? null : Math.max(0, b - a) });
  }
  return out;
}

// Clips posted per UTC day from launch to today (last 60 days at most).
function clipsPerDay(live, launch, now) {
  const counts = new Map();
  for (const r of live) if (r.at) counts.set(r.at.slice(0, 10), (counts.get(r.at.slice(0, 10)) || 0) + 1);
  const first = Math.max(Date.parse((launch || new Date(now).toISOString()).slice(0, 10)), now - 59 * DAY);
  const out = [];
  for (let t = first; t <= now; t += DAY) {
    const d = new Date(t).toISOString().slice(0, 10);
    out.push({ d, n: counts.get(d) || 0 });
  }
  return out;
}

// Round-number milestones the campaign has crossed, each with the first hour the clean curve reached it. The step
// keeps four or more on the list (1M steps at 4.2M, 100K steps under 400K).
const STEPS = [1e5, 2.5e5, 5e5, 1e6, 2.5e6, 5e6, 1e7, 2.5e7, 5e7, 1e8];
function milestones(curve, total, now) {
  if (total < 1e5) return null;
  const step = [...STEPS].reverse().find(s => total / s >= 4) || STEPS[0];
  const hit = [];
  let i = 0;
  for (let m = step; m <= total; m += step) {
    while (i < curve.length && curve[i][1] < m) i++;
    hit.push({ v: m, t: curve[i]?.[0] || new Date(now).toISOString() });
  }
  return { step, hit };
}

// End-of-day totals (UTC days) plus the latest point, for the chart.
function dailyCurve(curve) {
  const days = new Map();
  for (const [iso, v] of curve) days.set(iso.slice(0, 10), v);
  const out = [];
  let prev = 0;
  for (const [d, total] of days) { out.push({ d, total, gained: Math.max(0, total - prev) }); prev = total; }
  return out;
}

// Clips we stand behind: approved, or cleared by Eclipse's review, and the post is still up.
export function verifiedRows(cfg, rows) {
  const cleared = new Set(cfg.cleared || []);
  return rows.filter(r => IN_CAMPAIGN.has(r.st) && !r.del && (r.st === 'approved' || cleared.has(r.id.slice(0, 8))));
}

export function buildSnapshot({ cfg, campaign, rows, curve = [], rowHistory = {}, now = Date.now(), dataAsOf = null }) {
  const recs = cfg.recordings || {};
  const titles = cfg.titles || {};
  const live = rows.filter(r => IN_CAMPAIGN.has(r.st));
  const verified = verifiedRows(cfg, rows);

  // shares + saves for one clip: its recording scaled to today's views, else Content Rewards' count
  const ss = r => {
    const rec = recs[r.id.slice(0, 8)];
    if (!rec) return r.sh;
    const base = n(rec.shares) + n(rec.saves);
    return rec.rv > 0 ? base * (r.v / rec.rv) : base;
  };
  const sum = (xs, f) => xs.reduce((a, x) => a + f(x), 0);
  const verifiedViews = sum(verified, r => r.v);
  const parts = { likes: sum(verified, r => r.l), comments: sum(verified, r => r.c), sharesSaves: sum(verified, ss) };
  const engagements = parts.likes + parts.comments + parts.sharesSaves;
  const withRecording = verified.filter(r => recs[r.id.slice(0, 8)]);

  const title = r => titles[postCode(r.url)] || titles[r.id.slice(0, 8)] || cleanTitle(r.ti) || 'Watch the clip';
  const clip = r => ({
    title: title(r), p: r.p, v: r.v, url: r.url, th: r.th, at: r.at,
    er: r.v ? (r.l + r.c + ss(r)) / r.v : null,
  });
  const byViews = [...verified].sort((a, b) => b.v - a.v);
  const topN = cfg.topN || 5;

  // per-clip views 24h ago, from the hourly history the sync keeps for verified clips
  let rising = [], verified24h = null;
  const t24 = now - DAY;
  const hours = Object.keys(rowHistory).sort();
  const then = hours.filter(h => Date.parse(h) <= t24).pop();
  if (then && t24 - Date.parse(then) <= 2 * 3600e3) {
    const past = rowHistory[then];
    // verified views gained in 24 hours, over the clips the history saw then (a clip approved since adds nothing)
    verified24h = sum(verified, r => past[r.id.slice(0, 8)] == null ? 0 : Math.max(0, r.v - n(past[r.id.slice(0, 8)])));
    rising = verified
      .map(r => ({ r, gain: r.v - n(past[r.id.slice(0, 8)]) }))
      .filter(x => past[x.r.id.slice(0, 8)] != null && x.gain >= 500)
      .sort((a, b) => b.gain - a.gain).slice(0, 5)
      .map(x => ({ ...clip(x.r), gain: x.gain,
        spark: [...hours.filter(h => Date.parse(h) >= Date.parse(then)).map(h => rowHistory[h][x.r.id.slice(0, 8)])
          .filter(v => v != null), x.r.v] }));
  }

  // audience: creators' Insights market splits, weighted by each clip's views now
  let audience = null;
  const marketW = {}; let wSum = 0;
  for (const r of withRecording) {
    const m = recs[r.id.slice(0, 8)].markets;
    if (!m || !r.v) continue;
    wSum += r.v;
    for (const [cc, pct] of Object.entries(m)) {
      const k = cc === 'GB' ? 'UK' : cc;
      marketW[k] = (marketW[k] || 0) + r.v * pct;
    }
  }
  if (wSum > 0) {
    const markets = Object.entries(marketW).map(([cc, w]) => ({ cc, name: COUNTRY[cc] || cc, pct: w / wSum }))
      .sort((a, b) => b.pct - a.pct).slice(0, 5);
    const rest = Math.max(0, 100 - markets.reduce((a, m) => a + m.pct, 0));
    audience = { markets, rest, clips: withRecording.length };
  }

  const platforms = {};
  for (const r of live) {
    const p = (platforms[r.p] ||= { p: r.p, clips: 0, views: 0 });
    p.clips++; p.views += r.v;
  }

  const totalViews = sum(live, r => r.v);
  const past24 = curveAt(curve, t24);
  const launch = campaign.launchDate || campaign.createdAt;
  const status = campaign.status === 'active' ? 'live'
    : campaign.statusReason === 'budget_exhausted' ? 'budget_complete'
    : campaign.status === 'paused' ? 'paused' : 'ended';

  return {
    v: 1,
    generatedAt: new Date(now).toISOString(),
    dataAsOf: dataAsOf || new Date(now).toISOString(),
    client: { ...cfg.display, art: !!cfg.art },   // the art itself is sealed separately (sync.mjs writeArt)
    campaign: {
      status, launch,
      day: launch ? Math.floor((now - Date.parse(launch)) / DAY) + 1 : null,
      platforms: Object.values(platforms).sort((a, b) => b.views - a.views),
    },
    kpis: {
      totalViews,
      verifiedViews,
      clips: live.length,
      creators: new Set(live.map(r => r.u)).size,
      engagement: verifiedViews ? engagements / verifiedViews : null,
      engagementBasis: withRecording.length ? 'likes, comments, shares and saves' : 'likes, comments and shares',
      engagementParts: verifiedViews ? Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, v / verifiedViews])) : null,
      views24h: past24 == null ? null : Math.max(0, totalViews - past24),
      verified24h,
      clips24h: live.filter(r => Date.parse(r.at) >= t24).length,
    },
    curve: dailyCurve(curve),
    pulse: pulse(curve, now, 168),
    milestones: milestones(curve, totalViews, now),
    clipsPerDay: clipsPerDay(live, launch, now),
    top: byViews.slice(0, topN).map(clip),
    wall: byViews.slice(topN, topN + 24).map(clip),
    rising,
    // the newest verified clips, for the strip on the clips number
    latest: [...verified].filter(r => r.at && r.th).sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 12)
      .map(r => ({ th: r.th, at: r.at, p: r.p })),
    audience,
    reactions: cfg.reactions || null,
  };
}
