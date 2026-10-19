// Mac-side commands. Everything recurring happens in GitHub Actions; these are the one-off steps.
//
//   node src/cli.mjs init     make the master key (~/.eclipse-live/key) and store it as the ECLIPSE_KEY repo secret
//   node src/cli.mjs config   encrypt config/clients.local.json into config/config.enc (commit and push it after)
//   node src/cli.mjs login    open Chrome, sign in to Whop yourself, save the session for the cloud job
//   node src/cli.mjs links    print each client's dashboard link and password
//   node src/cli.mjs status   when the cloud job last published
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { KEY_FILE, masterKey, seal, unseal } from './crypto.mjs';
import { ROOT, STATE_FILE, artSrc, launchChrome, loadConfig, openContentRewards } from './sync.mjs';

const LOCAL = join(ROOT, 'config', 'clients.local.json');
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: ROOT, ...opts }).toString().trim();
const repo = () => run('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']);

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
    const key = await masterKey();
    const cfg = JSON.parse(readFileSync(LOCAL, 'utf8'));
    // the key art rides inside the sealed config, so the repo never holds a readable picture
    cfg.clients = cfg.clients.map(c => c.art ? { ...c, art: artSrc(c.art) } : c);
    const box = await seal(key, cfg);
    writeFileSync(join(ROOT, 'config', 'config.enc'), JSON.stringify(box));
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
    console.log('Signed in and checked. The session is saved (encrypted) for the cloud job; the next run picks it up.');
  },

  async links() {
    const cfg = JSON.parse(readFileSync(LOCAL, 'utf8'));
    for (const c of cfg.clients) console.log(`${c.display.talent}\n  ${cfg.siteUrl}/${c.slug}/\n  password: ${c.password}\n`);
  },

  async status() {
    const cfg = JSON.parse(readFileSync(LOCAL, 'utf8'));
    const s = await (await fetch(`${cfg.siteUrl}/status.json?x=${Date.now()}`)).json();
    const mins = Math.round((Date.now() - Date.parse(s.at)) / 60e3);
    console.log(`Last published ${mins} min ago (${s.at})${s.ok ? '' : `, ${s.failed} campaign(s) failed`}.`);
    if (mins > 45) console.log('Older than expected: check the Actions tab, or run `npm run login` if Whop signed out.');
  },
};

const cmd = commands[process.argv[2]];
if (!cmd) { console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(0, 8).join('\n')); process.exit(1); }
cmd().catch(e => { console.error(e.message || e); process.exit(1); });
