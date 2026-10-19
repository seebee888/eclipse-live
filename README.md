# Eclipse Live

Password-protected live dashboards for Eclipse clients. Every 15 minutes a GitHub Actions job opens Content Rewards
with a saved Whop session, pulls each client's campaign, and publishes fresh numbers to GitHub Pages. Nobody's
computer has to be on, and Claude doesn't need to be running. The marketing site serves the same pages at
`https://eclipseclipping.com/live/` (a Vercel rewrite to GitHub Pages), and that's the address clients get.

```
GitHub Actions (every 15 min)                         GitHub Pages
  headless Chrome + saved Whop session ──► pull ──►     /<client>/            the dashboard (same page for everyone)
  src/pull.js runs inside Content Rewards              /d/<id>.json          that client's numbers, AES-256 encrypted
  src/metrics.mjs turns rows into a snapshot           /d/<id>.art.json      that client's key art, encrypted the same way
                                                       /sw.js                offline fallback
  sealed with the client's password ──────────────►    /status.json          when the last run finished
```

## What's public and what isn't

This repo is public, because public repos get unlimited free Actions minutes. Nothing readable is in it:

| Where | What | Protected by |
|---|---|---|
| `config/config.enc` | clients, passwords, key art, review lists, Insights recordings | master key (`ECLIPSE_KEY` secret + `~/.eclipse-live/key` on the Mac) |
| `state` branch | the Whop browser session and chart history (one commit, replaced every run) | master key |
| `d/<id>.json`, `d/<id>.art.json` on the site | each client's numbers and key art | that client's password (PBKDF2-SHA256, 600k rounds → AES-256-GCM) |
| Actions logs | `client 1/2: ok, 762 rows` only | no names or numbers are logged |

The page decrypts in the browser. "Keep me signed in" stores the derived key on that device. The password itself
is never stored. Each dashboard sits at a random link (`/<slug>/`, ten random characters), so someone who finds one
sees a password box and nothing else: not whose it is, not the key art, not a single number.

Client names never go in anything public: tracked files, commit messages, file names, or Actions logs. They live
only in `config/clients.local.json` and `config/art/`, which stay on the Mac (gitignored), and inside the sealed
`config/config.enc`.

## The numbers (kept in line with the Phase reports)

- **Total views**: views on every clip still in the campaign (every status except rejected).
- **Verified views**: approved clips, plus clips Eclipse's review cleared (`cleared` in the config), while the post is still up.
- **Clips posted** / **creators**: clips still in the campaign, and the distinct creators behind them.
- **Engagement rate**: (likes + comments + shares + saves) ÷ views over verified clips. Shares and saves come from
  creators' Instagram Insights recordings, scaled to each clip's views today. A clip without a recording counts
  Content Rewards' share count, so the rate never overstates.
- **Views over time**: Content Rewards' hourly campaign series minus every rejected clip's own series. It matches
  the sum of the clips exactly. After that, the job adds a point every 15 minutes.
- **Last 24 hours**, **48 hours**, **Still climbing**: from the history the job keeps on the `state` branch, so they
  appear once the job has been running for a day.
- Display rules: numbers round down (4.2M, 459K, 1.29M). Budgets, payouts and review statuses are never shown,
  and commenters are never quoted.

## Day-to-day

```bash
npm run links      # every client's link + password (reads the local config; never committed)
npm run status     # when the cloud job last published
```

**When Whop signs out** (the job fails and GitHub emails you; dashboards keep the last numbers and the
"updated" pill turns amber after 40 minutes):

```bash
npm run login      # Chrome opens, you sign in to Whop yourself, the session is saved for the cloud job
```

**Add a client or change a password:** edit `config/clients.local.json` (copy an existing client; generate a new
random `slug`, `password`, `salt` and `fileId`), save the key art as `config/art/<fileId>.jpg` (1600×900) and point
the client's `art` at it (`"art": "art/<fileId>.jpg"`), then:

```bash
npm run config && git add config/config.enc && git commit -m "Update clients" && git push
```

Keep the client's name out of the commit message: the repo is public.

The push triggers a run, and the new page is live a couple of minutes later. Changing a password signs out
everyone who saved the old one.

**Preview locally** from a saved pull: `node scripts/preview.mjs <pull.json> <slug>=<pull key> …`, then serve `dist/`.

## One-time setup (already done for seebee888/eclipse-live)

1. `gh auth refresh -h github.com -s workflow` (lets git push the workflow file).
2. `node src/cli.mjs init`: creates the master key and stores it as the `ECLIPSE_KEY` repo secret.
3. `npm run config`, commit, push. Pages is set to deploy from GitHub Actions.
4. `npm run login`.

## The page

`site/app.html` is the whole dashboard: no build step and no framework.
- **Look:** a white page with black type and numbers, and the Eclipse mark's purple for emphasis (violet `#7047CF`,
  lilac `#B087E7`, lens `#402087`), the same for every client. The `accent`, `accent2`, `accent3` and `ramp` fields in
  a client's `display` config are no longer used. Panels are flat light grey with no borders; only the bar is frosted
  glass. The type matches the Eclipse pitch deck: Bricolage Grotesque ExtraBold for names, headings and numbers, and
  Archivo for everything else.
- **Sign-in:** white, with the mark's two circles sliding together into the eclipse.
- **The hero:** the talent's name, the show as a "now streaming" card with its key art (sealed, opened after sign-in), the campaign
  status, day, launch date and platforms, and the total views, with a chip under it that takes turns showing real
  facts (views in the last 24 hours, the newest clip while it's under two days old, the biggest market, the top clip).
  - With audience data, the hero's other half is the Earth: a dotted globe drawn in WebGL from
    `site/assets/earth.json` (built once by `tools/earth.mjs` from Natural Earth country shapes) on a pale sphere.
    Every dot knows its country, so a market fills in violet as the whole country, with ripples spreading across it,
    while the rest of the land stays grey. The globe never stops: it drifts and sways, tours the markets and keeps
    turning while it holds on one, and its label rides on the market. The markets are listed beside it as a key;
    picking one turns the globe to it, and dragging (or flicking) the globe takes over for a few seconds. If the map or
    WebGL isn't available, the list stands on its own.
  - Without audience data, the key art takes that side of the hero.
- **Four numbers**, written out in full and counting up (and rolling to the new value on an update):
  - Views per hour (24-hour average, with bars for the last 48 hours; the hour still running breathes). Before there's
    a 24-hour figure it shows views per day since launch instead.
  - Verified views, their share of all views and, once the sync has a day of history, what they gained in 24 hours.
  - Engagement, split into likes, comments, and shares & saves.
  - Clips posted, with a strip of the newest clips sliding past.
- **Top clips:** a ranked shelf with big outlined numbers, each clip with its views, share of all views and engagement.
- **The board** (panels pair up side by side, and one without a partner takes the full row):
  - Views over time (Total, Per day, Last 48 hours; a marker where each milestone landed).
  - Milestones: the next one, how much is left, the date at this week's pace (shown if it's within 90 days), and when
    each earlier one landed.
  - When views come in: a heatmap of the last 7 days by hour, in the viewer's time zone.
  - How fans reacted.
  - Still climbing.
- **More from the campaign:** the wall of clips.
- **Live:**
  - The pill in the floating bar shows how long ago the numbers updated and how many minutes until the next 15-minute
    update. Once you scroll past the name, the bar shows it too.
  - It checks for new data every minute (every 20 seconds once an update is due) and re-renders only when the numbers
    changed.
  - On a new update, the total rolls up and a note says how many views came in.
- **Motion:** the page opens on the Earth swinging round to the biggest market while the numbers count up, the line
  draws in and the bars rise. After that it keeps living: the globe roams, the facts chip turns over,
  the newest clips slide past, the live hour and the chart's latest point pulse, and the clip posters drift. It
  respects `prefers-reduced-motion` (everything holds still, and the globe rests on the biggest market).
- **App features:**
  - Installable as an app (manifest + service worker with an offline fallback).
  - "Big screen" mode: full screen with a screen wake lock, for a TV in a meeting room.
  - The Web Share API.

GitHub's scheduler can run a few minutes late at busy times, so "every 15 minutes" is sometimes every 20.
