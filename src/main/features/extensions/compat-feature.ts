/**
 * Electron wiring of the Raycast compatibility services (compat.ts): safeStorage, the glide:// OAuth
 * redirect, the AI feature's key, the native helper, the menu bar, Quick Look previews and the
 * snippet/quicklink stores. Returns the renderer-facing methods merged into the feature's methods.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { app, nativeImage, safeStorage, shell } from "electron";
import type { Quicklink, Snippet } from "@shared/types";
import { HEADLESS } from "../../headless";
import { clickMenuBarItem, menuBarState, registerMenuBarItem } from "../../menubar";
import type { FeatureContext } from "../types";
import { createAiAsker, createFakeAsker, type AiAsker } from "./ai-bridge";
import { RaycastCompat, type CompatDeps } from "./compat";
import { OAuthTokenStore, OAUTH_REDIRECT_PREFIX, type Cipher } from "./oauth";
import type { ExtensionRegistry } from "./registry";
import type { SessionManager } from "./sessions";

const str = (v: unknown) => (typeof v === "string" ? v : "");

/**
 * Headless tests must not touch the login keychain (safeStorage asks it for its key), so tokens are
 * only obfuscated there. Real runs always use safeStorage.
 */
const headlessCipher: Cipher = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(`headless:${Buffer.from(plain, "utf8").toString("base64")}`),
  decryptString: (buf) => Buffer.from(buf.toString().replace(/^headless:/, ""), "base64").toString("utf8"),
};

export interface QuickLookInfo {
  path: string;
  name: string;
  exists: boolean;
  isDirectory: boolean;
  size: number;
  modified: string | null;
  /** PNG data URL of the Quick Look thumbnail (images, PDFs, documents…). */
  image?: string;
  /** First 32 KB of a text file. */
  text?: string;
}

const TEXT_EXT = /\.(txt|md|markdown|json|js|cjs|mjs|ts|tsx|jsx|css|html?|xml|ya?ml|toml|ini|csv|log|sh|zsh|py|rb|go|rs|swift|c|h|cpp|java|kt|sql)$/i;

async function quickLook(p: string): Promise<QuickLookInfo> {
  const file = p.startsWith("~") ? path.join(app.getPath("home"), p.slice(1)) : p.replace(/^file:\/\//i, "");
  const info: QuickLookInfo = { path: file, name: path.basename(file), exists: false, isDirectory: false, size: 0, modified: null };
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return info;
  }
  Object.assign(info, { exists: true, isDirectory: st.isDirectory(), size: st.size, modified: st.mtime.toISOString() });
  if (st.isFile() && TEXT_EXT.test(file) && st.size < 4_000_000) {
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(Math.min(st.size, 32_768));
      fs.readSync(fd, buf, 0, buf.length, 0);
      info.text = buf.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
    return info;
  }
  try {
    // In-process Quick Look thumbnail (the same API Glide's icons use); nothing opens on screen.
    const img = await nativeImage.createThumbnailFromPath(file, { width: 640, height: 640 });
    if (!img.isEmpty()) info.image = img.toDataURL();
  } catch {
    /* no preview for this type */
  }
  return info;
}

export interface CompatWiring {
  compat: RaycastCompat;
  tokens: OAuthTokenStore;
  methods: Record<string, (...args: unknown[]) => unknown>;
}

export function wireCompat(opts: {
  ctx: FeatureContext;
  sessions: () => SessionManager;
  registry: () => ExtensionRegistry;
  launch: CompatDeps["launch"];
}): CompatWiring {
  const { ctx } = opts;
  const cipher: Cipher = HEADLESS ? headlessCipher : safeStorage;
  const aiSettings = () => {
    const all = (ctx.getGlobalSettings() as { features?: Record<string, Record<string, unknown>> }).features ?? {};
    return all.ai ?? {};
  };
  const ai: AiAsker = HEADLESS && process.env.GLIDE_EXT_FAKE_AI === "1" ? createFakeAsker() : HEADLESS ? { available: () => false, ask: () => Promise.reject(new Error("AI is disabled in headless mode")) } : createAiAsker({ aiDataDir: () => path.join(path.dirname(ctx.dataDir()), "ai"), cipher, settings: aiSettings });
  const capRaw = Number(process.env.GLIDE_EXT_INTERVAL_CAP_MS ?? "");
  const tokens = new OAuthTokenStore(path.join(ctx.dataDir(), "oauth"), cipher);

  const compat = new RaycastCompat({
    sessions: opts.sessions,
    registry: opts.registry,
    launch: opts.launch,
    getBackground: () => {
      const b = ctx.settings<{ background: Record<string, boolean> }>({ background: {} }).background;
      return b && typeof b === "object" ? b : {};
    },
    setBackground: (next) => ctx.setSettings({ background: next }),
    registerMenuBarItem,
    emit: (e) => ctx.emit("session", e),
    openView: (v) => ctx.openView(v),
    openExternal: (url) => shell.openExternal(url),
    helperCall: (method) => Promise.race([ctx.helper.call(method), new Promise((_r, reject) => setTimeout(() => reject(new Error(`${method} timed out`)), 4000))]),
    tokens,
    ai,
    setTimer: (fn, ms) => {
      const t = setTimeout(fn, ms);
      t.unref?.();
      return t;
    },
    clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
    intervalCapMs: HEADLESS && capRaw > 0 ? capRaw : undefined,
    log: (...a) => ctx.log(...a),
  });

  // glide://oauth?code=…&state=… comes back through the OS. Only packaged builds register the
  // scheme (it needs CFBundleURLTypes in Info.plist); headless tests call oauthRedirect instead.
  app.on("open-url", (event, url) => {
    if (!url.startsWith(OAUTH_REDIRECT_PREFIX)) return;
    event.preventDefault();
    if (!compat.redirect(url)) ctx.log("OAuth redirect with no matching sign-in request");
  });
  if (app.isPackaged && !HEADLESS && !app.isDefaultProtocolClient("glide")) app.setAsDefaultProtocolClient("glide");

  const methods: Record<string, (...args: unknown[]) => unknown> = {
    /** The user chose "Sign in with …" (⏎) in the OAuth card. */
    oauthOpen: (id) => compat.openAuthorization(str(id)),
    oauthCancel: (id) => compat.flows.cancel(str(id)),
    oauthPrompt: (id) => compat.flows.get(str(id)) ?? null,
    /** Deliver a glide://oauth redirect (the OS does this through open-url; tests call it directly). */
    oauthRedirect: (url) => compat.redirect(str(url)),
    backgroundState: () => compat.state(),
    setBackground: (ext, command, on) => compat.setEnabled(str(ext), str(command), on === true),
    /** Status items registered by extension menu-bar commands (function-free snapshot). */
    menuBarState: () => menuBarState().filter((s) => s.id.startsWith("ext:")),
    menuBarClick: (id, p) => (str(id).startsWith("ext:") && Array.isArray(p) ? clickMenuBarItem(str(id), p.map(Number)) : false),
    quickLook: (p) => quickLook(str(p)),
    /** Action.CreateSnippet / CreateQuicklink, after the user confirmed the prefilled form. */
    saveSnippet: (raw) => {
      const o = (raw ?? {}) as Record<string, unknown>;
      const text = str(o.text);
      if (!text.trim()) throw new Error("A snippet needs some text");
      const snippet: Snippet = { id: randomUUID(), name: str(o.name).trim() || text.slice(0, 40), text };
      if (str(o.keyword).trim()) snippet.keyword = str(o.keyword).trim();
      const saved = ctx.store.saveSnippet(snippet);
      ctx.refreshCatalogue();
      return saved;
    },
    saveQuicklink: (raw) => {
      const o = (raw ?? {}) as Record<string, unknown>;
      const url = str(o.link).trim();
      if (!/^[a-z][a-z0-9+.-]*:/i.test(url) || /^(javascript|data|vbscript):/i.test(url)) throw new Error("A quicklink needs a URL such as https://example.com/search?q={query}");
      const q: Quicklink = { id: randomUUID(), name: str(o.name).trim() || url, url };
      const saved = ctx.store.saveQuicklink(q);
      ctx.refreshCatalogue();
      return saved;
    },
  };
  return { compat, tokens, methods };
}
