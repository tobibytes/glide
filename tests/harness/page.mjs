// A connected renderer page: evaluate, wait, keyboard, screenshots.
import { connectCdp } from "./cdp.mjs";
import { parseKey } from "./keys.mjs";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** CSS that removes motion and the caret so screenshots are stable. */
export const STABLE_CSS = `*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition:none!important;caret-color:transparent!important;scroll-behavior:auto!important}`;

export class Page {
  /** @param {any} cdp @param {{ url: string, id: string }} target */
  constructor(cdp, target) {
    this.cdp = cdp;
    this.target = target;
    /** console.* calls and uncaught exceptions seen since connect: { at, type, text } */
    this.console = [];
    cdp.on("Runtime.consoleAPICalled", (e) => this.console.push({ at: Date.now(), type: e.type, text: e.args.map((a) => a.value ?? a.description ?? "").join(" ") }));
    cdp.on("Runtime.exceptionThrown", (e) => this.console.push({ at: Date.now(), type: "exception", text: e.exceptionDetails.exception?.description ?? e.exceptionDetails.text }));
  }

  /** Errors logged since `since` (console.error + uncaught exceptions). */
  errorsSince(since = 0) {
    return this.console.filter((c) => c.at >= since && (c.type === "error" || c.type === "exception"));
  }

  static async connect(target) {
    const cdp = await connectCdp(target.webSocketDebuggerUrl);
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    return new Page(cdp, target);
  }

  /** Evaluate an expression string, or a function (serialised) with JSON-able args. */
  async eval(exprOrFn, ...args) {
    const expression = typeof exprOrFn === "function" ? `(${exprOrFn.toString()})(...${JSON.stringify(args)})` : exprOrFn;
    const r = await this.cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(`page eval failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result?.value;
  }

  /** Poll until `exprOrFn` returns a truthy value; returns that value. */
  async waitFor(exprOrFn, { timeout = 5000, interval = 50, message } = {}, ...args) {
    const t0 = Date.now();
    let last;
    for (;;) {
      try {
        last = await this.eval(exprOrFn, ...args);
        if (last) return last;
      } catch (err) {
        last = err;
      }
      if (Date.now() - t0 > timeout) throw new Error(`waitFor timed out after ${timeout} ms: ${message ?? String(exprOrFn).slice(0, 120)} (last: ${last instanceof Error ? last.message : JSON.stringify(last)})`);
      await sleep(interval);
    }
  }

  waitForSelector(selector, opts = {}) {
    return this.waitFor((sel) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 || r.height > 0;
    }, { message: `selector ${selector}`, ...opts }, selector);
  }

  /** Resolve after `quietMs` without DOM mutations (or `timeout`). */
  waitForIdle({ quietMs = 200, timeout = 3000 } = {}) {
    return this.eval((quiet, max) => new Promise((resolve) => {
      let timer;
      const done = () => (obs.disconnect(), resolve(true));
      const obs = new MutationObserver(() => (clearTimeout(timer), (timer = setTimeout(done, quiet))));
      obs.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
      timer = setTimeout(done, quiet);
      setTimeout(done, max);
    }), quietMs, timeout);
  }

  /** Press a key spec ("Enter", "j", "cmd+k", "shift+Tab"). */
  async press(spec, { repeat = 1, delay = 30 } = {}) {
    const k = parseKey(spec);
    for (let i = 0; i < repeat; i++) {
      await this.cdp.send("Input.dispatchKeyEvent", { type: k.text ? "keyDown" : "rawKeyDown", key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk, modifiers: k.modifiers, text: k.text, unmodifiedText: k.text });
      await this.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk, modifiers: k.modifiers });
      if (delay) await sleep(delay);
    }
  }

  /** Insert text into the focused element (or `selector`, focused first). */
  async type(text, { selector } = {}) {
    if (selector) await this.eval((s) => document.querySelector(s)?.focus(), selector);
    await this.cdp.send("Input.insertText", { text });
  }

  /** Select-all + Backspace in `selector` (default: the first input). */
  async clear(selector = "input") {
    await this.eval((s) => {
      const el = document.querySelector(s);
      el?.focus();
      el?.select?.();
    }, selector);
    await this.press("Backspace");
  }

  /** Fix the viewport (CSS px) at 1x so captures are identical across retina/non-retina hosts. */
  async setViewport(width, height, { deviceScaleFactor = 1 } = {}) {
    await this.cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor, mobile: false });
  }

  async addStyle(css, id = "glide-test-style") {
    await this.eval((c, i) => {
      let st = document.getElementById(i);
      if (!st) {
        st = document.createElement("style");
        st.id = i;
        document.head.append(st);
      }
      st.textContent = c;
    }, css, id);
  }

  /** Disable motion/caret and isolate from the physical pointer (a moving mouse would hover-select rows). */
  async stabilise() {
    await this.cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] }).catch(() => {});
    await this.addStyle(`${STABLE_CSS} body *{pointer-events:none!important}`);
  }

  /** Bounding rects for every element matching any selector (for screenshot masks). */
  rects(selectors) {
    return this.eval((sels) => sels.flatMap((s) => [...document.querySelectorAll(s)].map((e) => {
      const r = e.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    })).filter((r) => r.width > 0 && r.height > 0), selectors);
  }

  /** PNG buffer of the viewport (or `clip` in CSS px). */
  async screenshot({ clip, background } = {}) {
    if (background) await this.cdp.send("Emulation.setDefaultBackgroundColorOverride", { color: background });
    const r = await this.cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false, ...(clip ? { clip: { ...clip, scale: 1 } } : {}) }, { timeout: 15000 });
    return Buffer.from(r.data, "base64");
  }

  location() {
    return this.eval("location.hash");
  }

  close() {
    this.cdp.close();
  }
}
