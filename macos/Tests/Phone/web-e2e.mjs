// Glide Remote in headless Chrome against a headless Glide (PhoneWebE2ETests runs this; it can also run by hand).
// Chrome runs with --headless=new and its own --user-data-dir, driven over the DevTools protocol (Node's
// built-in WebSocket, no packages). The page is emulated as an iPhone (390x844, touch).
//
// env: GLIDE_BASE      http://127.0.0.1:<port> of the headless app's phone server
//      GLIDE_PAIR      "<deviceId>.<key>" from the headless `phone/pairDevice` hook (activate: false)
//      GLIDE_CHROME    Chrome binary
//      GLIDE_PROFILE   empty directory for Chrome's profile (deleted by the caller)
//      GLIDE_SHOTS     directory for 390x844 screenshots (optional)
//      GLIDE_FILE_QUERY / GLIDE_FILE_TEXT   a file the Mac side can find, and its contents
// Prints one JSON line per step ({"step","ok",...}) and exits 1 when a step fails.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.GLIDE_BASE;
const PAIR = process.env.GLIDE_PAIR;
const CHROME = process.env.GLIDE_CHROME;
const PROFILE = process.env.GLIDE_PROFILE;
const SHOTS = process.env.GLIDE_SHOTS || '';
if (!BASE || !PAIR || !CHROME || !PROFILE) { console.error('GLIDE_BASE, GLIDE_PAIR, GLIDE_CHROME and GLIDE_PROFILE are required'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
function report(step, ok, extra) {
  if (!ok) failed = true;
  console.log(JSON.stringify(Object.assign({ step, ok }, extra || {})));
}

const chrome = spawn(CHROME, [
  '--headless=new', `--user-data-dir=${PROFILE}`, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking', '--disable-sync',
  '--disable-component-update', '--disable-default-apps', '--disable-features=Translate,MediaRouter,OptimizationHints',
  '--mute-audio', '--hide-scrollbars', '--window-size=390,844', 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });
let chromeErr = '';
chrome.stderr.on('data', (d) => { chromeErr += d; });
const killChrome = () => { try { chrome.kill('SIGKILL'); } catch (e) { /* gone */ } };
process.on('exit', killChrome);
const hardStop = setTimeout(() => { report('timeout', false, { stderr: chromeErr.slice(-2000) }); killChrome(); process.exit(1); }, 150000);

async function devtoolsPort() {
  const f = join(PROFILE, 'DevToolsActivePort');
  for (let i = 0; i < 200; i++) {
    if (existsSync(f)) { const port = parseInt(readFileSync(f, 'utf8').split('\n')[0], 10); if (port > 0) return port; }
    await sleep(50);
  }
  throw new Error('Chrome did not start: ' + chromeErr.slice(-1000));
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiting = new Map(); this.events = []; this.listeners = [];
    ws.onmessage = (m) => {
      const msg = JSON.parse(typeof m.data === 'string' ? m.data : Buffer.from(m.data).toString());
      if (msg.id && this.waiting.has(msg.id)) {
        const { resolve, reject } = this.waiting.get(msg.id);
        this.waiting.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
      } else if (msg.method) { this.events.push(msg); for (const l of this.listeners) l(msg); }
    };
  }
  send(method, params) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    return new Promise((resolve, reject) => this.waiting.set(id, { resolve, reject }));
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
    return r.result.value;
  }
  async waitFor(expr, ms) {
    const end = Date.now() + (ms || 10000);
    let last;
    while (Date.now() < end) {
      try { last = await this.eval(expr); if (last) return last; } catch (e) { last = String(e); }
      await sleep(100);
    }
    throw new Error('timed out waiting for ' + expr + ' (last: ' + JSON.stringify(last) + ')');
  }
}

async function main() {
  const port = await devtoolsPort();
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const cdp = new CDP(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await cdp.send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1', platform: 'iPhone' });
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  const consoleErrors = [];
  cdp.listeners.push((m) => {
    if (m.method === 'Runtime.exceptionThrown') consoleErrors.push(m.params.exceptionDetails.exception ? m.params.exceptionDetails.exception.description : m.params.exceptionDetails.text);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') consoleErrors.push(m.params.args.map((a) => a.value || a.description).join(' '));
  });

  async function shot(name) {
    if (!SHOTS) return;
    mkdirSync(SHOTS, { recursive: true });
    await sleep(350);
    await cdp.eval(`document.querySelectorAll('.toast-msg').forEach(t => t.remove())`);
    const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(join(SHOTS, name + '.png'), Buffer.from(r.data, 'base64'));
  }
  async function route(r, ready) {
    await cdp.eval(`location.hash = '#/${r}'`);
    await cdp.waitFor(ready || `document.querySelector('.page-title') !== null`, 8000);
  }
  async function step(name, f) {
    try { const extra = await f(); report(name, true, extra); } catch (e) { report(name, false, { error: String(e && e.message || e) }); }
  }

  // Unpaired first (fresh profile), then pair through the URL fragment like a scanned QR code.
  await step('unpaired screen', async () => {
    await cdp.send('Page.navigate', { url: BASE + '/' });
    await cdp.waitFor(`document.querySelector('.steps-list') !== null`);
    const text = await cdp.eval('document.body.innerText');
    if (!/Pair iPhone/.test(text)) throw new Error('no pairing instructions: ' + text.slice(0, 200));
    await shot('unpaired');
  });

  await step('pair from #pair= link', async () => {
    await cdp.send('Page.navigate', { url: BASE + '/#pair=' + PAIR });
    await cdp.waitFor(`!!localStorage.getItem('glide.pairing') && location.hash === '#/home'`, 15000);
    const href = await cdp.eval('location.href');
    if (href.includes(PAIR.split('.')[1])) throw new Error('the key is still in the address: ' + href);
    const stored = JSON.parse(await cdp.eval(`localStorage.getItem('glide.pairing')`));
    if (stored.deviceId + '.' + stored.key !== PAIR) throw new Error('stored pairing differs');
    return { name: stored.name, mac: stored.mac };
  });

  await step('status on Home', async () => {
    await cdp.waitFor(`document.body.innerText.includes('Connected')`, 10000);
    const st = await cdp.eval(`GlideAPI.call('status').then(r => r)`);
    if (!st || !st.mac || !Array.isArray(st.timers)) throw new Error('bad status ' + JSON.stringify(st));
    await shot('home');
    return { mac: st.mac.name };
  });

  await step('send text through the Send screen', async () => {
    await route('send');
    await cdp.eval(`(() => { const t = document.querySelector('textarea'); t.value = 'Hello from Glide Remote'; [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Send').click(); })()`);
    const toast = await cdp.waitFor(`[...document.querySelectorAll('.toast-msg.success')].map(t => t.textContent).find(t => t.includes('Copied'))`, 10000);
    await cdp.eval(`(() => { document.querySelector('textarea').value = 'https://glide.madebytobi.com'; })()`);
    await shot('send');
    return { toast };
  });

  await step('clipboard screen shows the Mac clipboard', async () => {
    await route('clipboard', `document.querySelector('textarea') && document.querySelector('textarea').value === 'Hello from Glide Remote'`);
    const copied = await cdp.eval(`GlideRemote.copyText('copy check')`);
    await shot('clipboard');
    return { execCommandCopy: copied };
  });

  await step('remote: type, keys, trackpad tap and drag', async () => {
    const r1 = await cdp.eval(`GlideAPI.call('type.text', {text: 'typed from the phone'})`);
    const r2 = await cdp.eval(`GlideAPI.call('keys.press', {key: 'k', modifiers: ['cmd']})`);
    await route('remote', `document.querySelector('.trackpad') !== null`);
    const box = await cdp.eval(`(() => { const r = document.querySelector('.trackpad').getBoundingClientRect(); return {x: r.left + r.width / 2, y: r.top + r.height / 2}; })()`);
    const tp = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts });
    await tp('touchStart', [{ x: box.x, y: box.y, id: 1 }]);
    await tp('touchEnd', []);
    await sleep(400);
    await tp('touchStart', [{ x: box.x, y: box.y, id: 1 }]);
    for (let i = 1; i <= 8; i++) { await tp('touchMove', [{ x: box.x + i * 6, y: box.y + i * 3, id: 1 }]); await sleep(16); }
    await tp('touchEnd', []);
    await sleep(600);
    await shot('remote-trackpad');
    await cdp.eval(`[...document.querySelectorAll('.segmented button')].find(b => b.textContent === 'Keys').click()`);
    await shot('remote-keys');
    await cdp.eval(`[...document.querySelectorAll('.segmented button')].find(b => b.textContent === 'Slides').click()`);
    await cdp.eval(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('Next')).click()`);
    await sleep(400);
    await shot('remote-slides');
    await cdp.eval(`[...document.querySelectorAll('.segmented button')].find(b => b.textContent === 'Media').click()`);
    await shot('remote-media');
    await cdp.eval(`[...document.querySelectorAll('.segmented button')].find(b => b.textContent === 'Trackpad').click()`);
    return { type: r1, keys: r2 };
  });

  await step('search Glide', async () => {
    await route('search');
    const r = await cdp.eval(`GlideAPI.call('search', {query: 'calc', limit: 5})`);
    await cdp.eval(`(() => { const f = document.querySelector('input[type=search]'); f.value = 'settings'; f.dispatchEvent(new Event('input')); })()`);
    await cdp.waitFor(`document.querySelectorAll('.rowbtn').length > 0 || document.body.innerText.includes('Nothing found')`, 8000);
    await shot('search');
    return { items: (r.items || []).length };
  });

  if (process.env.GLIDE_FILE_QUERY) {
    await step('files: search and download', async () => {
      const q = process.env.GLIDE_FILE_QUERY;
      const r = await cdp.eval(`GlideAPI.call('files.search', {query: ${JSON.stringify(q)}})`);
      if (!r.files || !r.files.length) throw new Error('no files found');
      const got = await cdp.eval(`GlideAPI.call('files.get', {path: ${JSON.stringify(r.files[0].path)}}).then(x => new TextDecoder().decode(GlideCrypto.fromB64(x.data)))`);
      if (got !== process.env.GLIDE_FILE_TEXT) throw new Error('downloaded bytes differ: ' + got);
      await route('files');
      await cdp.eval(`(() => { const f = document.querySelector('input[type=search]'); f.value = ${JSON.stringify(q)}; f.dispatchEvent(new Event('input')); })()`);
      await cdp.waitFor(`document.querySelectorAll('.rowbtn').length > 0`, 8000);
      await shot('files');
      return { files: r.files.length };
    });
  }

  await step('denied explains the switch', async () => {
    const msg = await cdp.eval(`GlideAPI.call('agent.ask', {prompt: 'hi'}).then(() => 'ran', e => GlideRemote.explain(e))`);
    return { message: msg };
  });

  await step('approval deep link', async () => {
    await cdp.eval(`location.hash = '#approve=missing-request'`);
    await cdp.waitFor(`location.hash === '#/agent' && (document.body.innerText.includes('already answered') || document.body.innerText.includes('Approvals aren'))`, 8000);
    await shot('agent-approvals');
    await cdp.eval(`[...document.querySelectorAll('.segmented button')].find(b => b.textContent === 'Chat').click()`);
    await shot('agent-chat');
  });

  await step('more and settings', async () => {
    await route('more');
    await shot('more');
    await route('settings', `document.body.textContent.includes('Turned on in Glide')`);
    await shot('settings');
  });

  await step('dark mode', async () => {
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
    await cdp.waitFor(`document.documentElement.dataset.theme === 'dim'`, 3000);
    await route('home', `document.body.innerText.includes('Connected')`);
    await shot('home-dark');
    await route('remote', `document.querySelector('.trackpad') !== null`);
    await shot('remote-dark');
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  });

  report('no page errors', consoleErrors.length === 0, { errors: consoleErrors.slice(0, 5) });
  ws.close();
}

main().catch((e) => report('driver', false, { error: String(e && e.stack || e) })).finally(() => {
  clearTimeout(hardStop);
  killChrome();
  process.exit(failed ? 1 : 0);
});
