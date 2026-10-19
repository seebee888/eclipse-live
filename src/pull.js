// Runs inside a signed-in Content Rewards tab (*.apps.whop.com) and defines window.__eclipsePull(campaignId, opts).
// GET requests only: it never writes to Content Rewards. The sync injects this file with Playwright; the same file
// can be pasted into the Claude browser pane for a spot check.
(() => {
  const n = v => Number(v || 0);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const HOUR = 3600e3;
  const floorHour = t => new Date(Math.floor(t / HOUR) * HOUR).toISOString();
  // analytics buckets read "2026-10-01 05:00:00" (UTC)
  const bucketIso = b => new Date(b.replace(' ', 'T') + 'Z').toISOString();

  async function getJSON(path, tries = 5) {
    for (let k = 0; k < tries; k++) {
      let r = null;
      try { r = await fetch(path, { credentials: 'include', cache: 'no-store' }); } catch { /* network blip: retry */ }
      if (r && r.ok) return r.json();
      if (r && (r.status === 401 || r.status === 403)) {
        const e = new Error(`signed out (${r.status})`); e.auth = true; throw e;
      }
      if (r && r.status === 404) return null;
      await sleep(1500 * (k + 1));            // 503 "Service busy" and throttle pages clear in a few seconds
    }
    throw new Error('Content Rewards did not answer: ' + path.split('?')[0]);
  }

  function compactRow(s) {
    const p = s.socialMediaPost || {};
    return {
      id: s.id, st: s.reviewStatus, p: p.platform || 'instagram',
      v: n(p.views), l: n(p.likes), c: n(p.comments), sh: n(p.shares),
      at: p.createdAt || s.createdAt, url: p.postUrl || null, th: p.thumbnailUrl || null,
      ti: (p.title || '').slice(0, 400), u: s.userId, del: p.status === 'deleted' || !!s.isDeleted,
      vo: s.viewsObservedAt || null,
    };
  }

  async function allRows(cid) {
    let cursor = null, out = [];
    for (let i = 0; i < 200; i++) {
      const j = await getJSON(`/api/submission/submissions?campaignIds=${cid}&limit=100`
        + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''));
      const page = (j && j.data) || [];
      out = out.concat(page.map(compactRow));
      cursor = j && j.pagination && j.pagination.nextCursor;
      if (!cursor || !page.length) break;
    }
    return out;
  }

  // Cumulative views on the clips still in the campaign, hour by hour since launch: the campaign's own hourly series
  // (every clip) minus the series of each rejected clip. Content Rewards' campaign total matches the sum of its rows
  // (checked 2026-10-15: 5,914,023 vs 5,914,092), so the difference is the clean curve.
  async function cleanCurve(cid, launch, rows) {
    const end = encodeURIComponent(floorHour(Date.now() + HOUR));
    const start = encodeURIComponent(floorHour(Date.parse(launch) - 24 * HOUR));
    const camp = await getJSON(`/api/analytics/stats/campaigns/${cid}?start=${start}&end=${end}&granularity=hour`);
    const inc = new Map();
    for (const x of (camp && camp.data && camp.data.series) || []) inc.set(bucketIso(x.bucket), n(x.views));
    const rejected = rows.filter(r => r.st === 'rejected');
    let next = 0;
    const worker = async () => {
      while (next < rejected.length) {
        const r = rejected[next++];
        const s = encodeURIComponent(floorHour(Date.parse(r.at) - HOUR));
        const j = await getJSON(`/api/analytics/stats/submissions/${r.id}?start=${s}&end=${end}&granularity=hour&campaignId=${cid}`);
        for (const x of (j && j.data && j.data.series) || []) {
          const v = n(x.views);
          if (!v) continue;
          const b = bucketIso(x.bucket);
          inc.set(b, (inc.get(b) || 0) - v);
        }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    let cum = 0;
    const curve = [];
    for (const b of [...inc.keys()].sort()) {
      cum += inc.get(b);
      if (cum > 0 || curve.length) curve.push([b, Math.max(0, cum)]);
    }
    return curve;
  }

  window.__eclipsePull = async (cid, { curve = false } = {}) => {
    const c = (await getJSON(`/api/campaign/campaigns/${cid}`)).data;
    const rows = await allRows(cid);
    const campaign = {
      id: c.id, name: c.name, status: c.status, statusReason: c.statusReason || null,
      launchDate: c.launchDate || null, createdAt: c.createdAt, statusChangedAt: c.statusChangedAt || null, banner: c.banner,
    };
    const dataAsOf = rows.reduce((m, r) => (r.vo && r.vo > m ? r.vo : m), '') || null;
    return {
      campaign, rows, dataAsOf,
      curve: curve ? await cleanCurve(cid, campaign.launchDate || campaign.createdAt, rows) : null,
    };
  };
})();
