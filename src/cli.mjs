// Mac-side commands. Everything recurring happens in GitHub Actions; these are the one-off steps.
//
//   node src/cli.mjs init     make the master key (~/.eclipse-live/key) and store it as the ECLIPSE_KEY repo secret
//   node src/cli.mjs config   encrypt config/clients.local.json into config/config.enc (commit and push it after)
//   node src/cli.mjs login    open Chrome, sign in to Whop yourself, save the session for the cloud job
//   node src/cli.mjs new      add a client: a few questions, then their dashboard is published (--no-push: local only)
//   node src/cli.mjs links    print each client's dashboard link and password
//   node src/cli.mjs status   when the cloud job last published
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, extname, join, resolve } from 'node:path';
import { KEY_FILE, masterKey, seal, unseal } from './crypto.mjs';
import { ROOT, STATE_FILE, artSrc, launchChrome, loadConfig, openContentRewards } from './sync.mjs';
import { WORDS } from './words.mjs';

const LOCAL = join(ROOT, 'config', 'clients.local.json');
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: ROOT, ...opts }).toString().trim();
const repo = () => run('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']);

const rand = n => globalThis.crypto.getRandomValues(new Uint8Array(n));
const pick = (list, n) => Array.from(rand(n), b => list[b % list.length]);
const SLUG_CHARS = '23456789abcdefghjkmnpqrstuvwxyz';   // no 0/o or 1/l/i, so a link reads aloud cleanly

// clients.local.json keeps its own indentation when a command rewrites it
function readLocal() {
  const raw = readFileSync(LOCAL, 'utf8');
  return { cfg: JSON.parse(raw), indent: (raw.match(/\n( +)"/) || [, '  '])[1] };
}

async function sealConfig() {
  const key = await masterKey();
  const { cfg } = readLocal();
  // the key art rides inside the sealed config, so the repo never holds a readable picture
  cfg.clients = cfg.clients.map(c => c.art ? { ...c, art: artSrc(c.art) } : c);
  writeFileSync(join(ROOT, 'config', 'config.enc'), JSON.stringify(await seal(key, cfg)));
}

// The session lives on the `state` branch as one commit that every save replaces, so no old session lingers in history.
function pushState() {
  const blob = run('git', ['hash-object', '-w', STATE_FILE]);
  const tree = run('git', ['mktree'], { input: `100644 blob ${blob}\tstate.enc\n` });
  const commit = run('git', ['-c', 'user.name=eclipse-live', '-c', 'user.email=eclipse-live@users.noreply.github.com',
    'commit-tree', tree, '-m', 'Whop session (encrypted)']);
  run('git', ['push', '-q', '-f', 'origin', `${commit}:refs/heads/state`]);
}

const commands = {
  async init() {
    if (!existsSync(KEY_FILE)) {
      mkdirSync(dirname(KEY_FILE), { recursive: true, mode: 0o700 });
      writeFileSync(KEY_FILE, Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(32))).toString('base64'));
      chmodSync(KEY_FILE, 0o600);
      console.log(`Master key created at ${KEY_FILE}`);
    }
    run('gh', ['secret', 'set', 'ECLIPSE_KEY', '-R', repo()], { input: readFileSync(KEY_FILE) });
    console.log('ECLIPSE_KEY secret set on', repo());
  },

  async config() {
    await sealConfig();
    console.log('config/config.enc updated. Commit and push it to publish the change.');
  },

  async login() {
    const key = await masterKey();
    const cfg = await loadConfig(key);
    const browser = await launchChrome({ headless: false });
    const context = await browser.newContext({ viewport: null });
    const page = await context.newPage();
    await page.goto('https://whop.com/login/');
    console.log('Sign in to Whop in the Chrome window that just opened, with the account that runs the Eclipse business.');
    console.log('Once you are in, a second tab opens Content Rewards to confirm access. This waits up to 10 minutes.');
    const deadline = Date.now() + 10 * 60e3;
    let ok = null, probe = null;
    while (Date.now() < deadline && !ok) {
      await new Promise(r => setTimeout(r, 5000));
      if (page.isClosed()) break;
      if (/\/(login|signup|sign-in|auth|verify|otp)/.test(new URL(page.url()).pathname)) continue;   // still signing in
      probe ||= await context.newPage();
      ok = await openContentRewards(context, cfg, { timeout: 15000, page: probe }).catch(() => null);
    }
    if (!ok) { await browser.close(); throw new Error('Did not reach the Content Rewards business side in 10 minutes. Run npm run login again.'); }
    const userAgent = await ok.evaluate(() => navigator.userAgent);
    const storage = await context.storageState();
    await browser.close();

    // the cloud job runs headless, so prove the saved session works that way before keeping it
    const check = await launchChrome();
    try {
      const ctx = await check.newContext({ storageState: storage, userAgent, viewport: { width: 1280, height: 900 } });
      await openContentRewards(ctx, cfg);
    } catch (e) {
      throw new Error(`Signed in, but the saved session did not open Content Rewards headless (${e.message}). Nothing was saved.`);
    } finally { await check.close(); }

    const old = existsSync(STATE_FILE) ? await unseal(key, JSON.parse(readFileSync(STATE_FILE, 'utf8'))).catch(() => ({})) : {};
    const state = { ...old, storage, userAgent, loginAt: new Date().toISOString() };
    writeFileSync(STATE_FILE, JSON.stringify(await seal(key, state)));
    pushState();
    console.log('Signed in and checked. The session is saved (encrypted) for the cloud job.');
    // switch the job back on if it was paused while signed out, and refresh every dashboard now
    try {
      run('gh', ['workflow', 'enable', 'sync.yml'], { stdio: 'pipe' });
      run('gh', ['workflow', 'run', 'sync.yml'], { stdio: 'pipe' });
      console.log('A sync is running now. Dashboards update in about 3 minutes.');
    } catch { console.log('The next scheduled run (within 15 minutes) picks it up.'); }
  },

  // Everything a new dashboard needs, from a few questions: the campaign, the names it shows, the key art. Generates a
  // random link, password, salt and file name, seals the config, commits it without the client's name and pushes,
  // which starts a sync that publishes the dashboard.
  async new() {
    const push = !process.argv.includes('--no-push');
    const rl = createInterface({ input: process.stdin, terminal: false });   // the terminal echoes and edits the line itself
    const lines = rl[Symbol.asyncIterator]();
    const ask = async (q, def = '') => {
      process.stdout.write(def ? `${q} [${def}]: ` : `${q}: `);
      const { value, done } = await lines.next();
      if (done) throw new Error('Stopped before all the answers were in. Nothing was changed.');
      return value.trim() || def;
    };
    const { cfg, indent } = readLocal();
    console.log('New client dashboard. Press Enter to take the value in [brackets].\n');
    let campaignId;
    for (;;) {
      campaignId = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(await ask('Content Rewards campaign link or ID'))?.[0];
      if (!campaignId) { console.log('  That has no campaign ID in it. Paste the campaign page link from Content Rewards.'); continue; }
      const dupe = cfg.clients.find(c => c.campaignId === campaignId);
      if (!dupe) break;
      console.log(`  ${dupe.display.talent} already has that campaign. Run npm run links to see their dashboard.`);
    }
    let talent;
    while (!(talent = await ask('Client name, as their dashboard shows it'))) console.log('  The dashboard needs a name.');
    const title = await ask('Title of the release', '');
    const network = await ask('Where to watch it, e.g. Netflix (Enter for none)', '');
    const networkLine = network ? await ask('Words before it', 'Now streaming on') : undefined;
    let art = '';
    for (;;) {
      // dragging a file into Terminal pastes its path, quoted or with escaped spaces
      art = (await ask('Key art, about 1600×900: drag the image here (Enter for none)', '')).replace(/^['"]|['"]$/g, '').replace(/\\(.)/g, '$1');
      if (!art || (existsSync(art) && /^\.(jpe?g|png|webp)$/i.test(extname(art)))) break;
      console.log('  Couldn\u2019t use that. It needs to be a .jpg, .png or .webp file that exists.');
    }
    const topN = Math.min(20, Math.max(1, parseInt(await ask('How many top clips to show', '5'), 10) || 5));

    const taken = new Set(cfg.clients.flatMap(c => [c.slug, c.fileId]));
    let slug, fileId;
    do slug = pick(SLUG_CHARS, 10).join(''); while (taken.has(slug));
    do fileId = Buffer.from(rand(8)).toString('hex'); while (taken.has(fileId));
    const password = [...pick(WORDS, 4), 10 + (rand(1)[0] % 90)].join('-');
    const c = {
      slug, password, salt: Buffer.from(rand(16)).toString('base64'), fileId, campaignId, topN,
      display: { talent, title, ...(network && { network, networkLine }) },
      cleared: [], recordings: {}, titles: {}, reactions: null,
    };
    const link = `${cfg.siteUrl}/${slug}/`;
    console.log(`\n${talent}${title ? ` · ${title}` : ''}${network ? ` · ${networkLine} ${network}` : ''}`);
    console.log(`  campaign ${campaignId}, top ${topN} clips, ${art ? 'with key art' : 'no key art'}`);
    console.log(`  ${link}`);
    if (!/^y(es)?$|^$/i.test(await ask(push ? 'Create it and publish? (Y/n)' : 'Create it locally? (Y/n)', ''))) {
      rl.close(); console.log('Nothing was changed.'); return;
    }
    rl.close();

    // keep a copy of the last version of the only file that knows every password
    const backups = join(dirname(KEY_FILE), 'backups');
    mkdirSync(backups, { recursive: true, mode: 0o700 });
    const backup = join(backups, `clients.local.${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    copyFileSync(LOCAL, backup); chmodSync(backup, 0o600);
    if (art) {
      mkdirSync(join(ROOT, 'config', 'art'), { recursive: true });
      c.art = `art/${fileId}${extname(art).toLowerCase()}`;
      copyFileSync(resolve(art), join(ROOT, 'config', c.art));
    }
    cfg.clients.push(c);
    writeFileSync(LOCAL, JSON.stringify(cfg, null, indent) + '\n');
    await sealConfig();
    if (push) {
      // the repo is public: the commit says nothing about who was added
      run('git', ['commit', '-q', '-m', 'Update clients', '--', 'config/config.enc']);
      run('git', ['push', '-q', 'origin', 'HEAD:main'], { stdio: ['ignore', 'pipe', 'inherit'] });
    }
    console.log(`\nDone. ${push ? 'It goes live with the sync that just started, in about 3 minutes.' : 'Saved locally; nothing was published.'}`);
    console.log(`  ${link}\n  password: ${password}`);
    console.log('Send both to the client. npm run links shows them again any time.');
    if (push) console.log('If it isn\u2019t up in 10 minutes, run npm run status (Whop may need npm run login).');
  },

  async links() {
    const cfg = JSON.parse(readFileSync(LOCAL, 'utf8'));
    for (const c of cfg.clients) console.log(`${c.display.talent}\n  ${cfg.siteUrl}/${c.slug}/\n  password: ${c.password}\n`);
  },

  async status() {
    const cfg = JSON.parse(readFileSync(LOCAL, 'utf8'));
    const r = await fetch(`${cfg.siteUrl}/status.json?x=${Date.now()}`);
    if (!r.ok) { console.log('Nothing is published yet. If the Actions tab says Whop signed out, run npm run login.'); return; }
    const s = await r.json();
    const mins = Math.round((Date.now() - Date.parse(s.at)) / 60e3);
    console.log(`Last published ${mins} min ago (${s.at})${s.ok ? '' : `, ${s.failed} campaign(s) failed`}.`);
    if (mins > 45) console.log('Older than expected: check the Actions tab, or run `npm run login` if Whop signed out.');
  },
};

const cmd = commands[process.argv[2]];
if (!cmd) { console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(0, 9).join('\n')); process.exit(1); }
cmd().catch(e => { console.error(e.message || e); process.exit(1); });
