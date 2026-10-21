/**
 * OAuth for Raycast extensions (OAuth.PKCEClient):
 *  - tokens live in <dir>/<extension>.bin, one encrypted JSON object per extension keyed by provider id,
 *    encrypted with Electron's safeStorage (injected as a Cipher; never written in plain text);
 *  - pending authorizations wait for the browser to come back to glide://oauth?code=…&state=….
 * No Electron imports: the feature wires safeStorage, shell.openExternal and the open-url event.
 */
import fs from "node:fs";
import path from "node:path";
import { isValidName } from "./manifest";

export interface Cipher {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export type TokenRecord = Record<string, unknown>;

export const OAUTH_REDIRECT_PREFIX = "glide://oauth";

export class OAuthTokenStore {
  constructor(
    private readonly dir: string,
    private readonly cipher: Cipher,
  ) {}

  private file(ext: string): string {
    if (!isValidName(ext)) throw new Error("Invalid extension name");
    return path.join(this.dir, `${ext}.bin`);
  }

  private readAll(ext: string): Record<string, TokenRecord> {
    const file = this.file(ext);
    let buf: Buffer;
    try {
      buf = fs.readFileSync(file);
    } catch {
      return {};
    }
    if (!buf.length || !this.cipher.isEncryptionAvailable()) return {};
    try {
      const parsed: unknown = JSON.parse(this.cipher.decryptString(buf));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, TokenRecord>) : {};
    } catch {
      return {};
    }
  }

  private writeAll(ext: string, all: Record<string, TokenRecord>) {
    const file = this.file(ext);
    if (!Object.keys(all).length) {
      fs.rmSync(file, { force: true });
      return;
    }
    if (!this.cipher.isEncryptionAvailable()) throw new Error("Secure storage is unavailable on this system, so OAuth tokens can't be saved");
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, this.cipher.encryptString(JSON.stringify(all)), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  get(ext: string, provider: string): TokenRecord | null {
    return this.readAll(ext)[provider] ?? null;
  }

  set(ext: string, provider: string, tokens: TokenRecord) {
    const all = this.readAll(ext);
    all[provider] = tokens;
    this.writeAll(ext, all);
  }

  remove(ext: string, provider: string) {
    const all = this.readAll(ext);
    delete all[provider];
    this.writeAll(ext, all);
  }

  /** Uninstall: drop every token of the extension. */
  clear(ext: string) {
    fs.rmSync(this.file(ext), { force: true });
  }
}

export interface OAuthRequest {
  id: string;
  extName: string;
  sessionId: string;
  url: string;
  state: string;
  providerName: string;
  providerIcon?: string;
  description?: string;
}

interface Pending extends OAuthRequest {
  resolve(code: string): void;
  reject(err: Error): void;
}

/** Authorizations waiting for the redirect. A request is matched by its `state` (CSRF protection). */
export class OAuthFlows {
  private readonly pending = new Map<string, Pending>();
  private seq = 0;

  start(req: Omit<OAuthRequest, "id">): { request: OAuthRequest; code: Promise<string> } {
    if (!req.state) throw new Error("OAuth authorization request has no state");
    let url: URL;
    try {
      url = new URL(req.url);
    } catch {
      throw new Error("OAuth authorization URL is invalid");
    }
    if (url.protocol !== "https:" && !(url.protocol === "http:" && /^(127\.0\.0\.1|localhost|\[::1\])$/.test(url.hostname)))
      throw new Error("OAuth authorization URLs must use https");
    const request: OAuthRequest = { ...req, id: `oa${++this.seq}` };
    const code = new Promise<string>((resolve, reject) => this.pending.set(request.id, { ...request, resolve, reject }));
    return { request, code };
  }

  get(id: string): OAuthRequest | undefined {
    const p = this.pending.get(id);
    if (!p) return undefined;
    const { resolve: _r, reject: _j, ...req } = p;
    return req;
  }

  cancel(id: string, reason = "Authorization was cancelled") {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    p.reject(new Error(reason));
  }

  /** Every pending authorization of a session (it ended). */
  cancelSession(sessionId: string) {
    for (const p of Array.from(this.pending.values())) if (p.sessionId === sessionId) this.cancel(p.id, "The command stopped");
  }

  /**
   * glide://oauth?code=…&state=… (or ?error=…). Returns the request id it completed, or null when
   * the URL is not an OAuth redirect or matches no pending state.
   */
  handleRedirect(raw: string): string | null {
    if (!raw.startsWith(OAUTH_REDIRECT_PREFIX)) return null;
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return null;
    }
    const params = new URLSearchParams(url.search);
    // Some providers put the response in the fragment.
    if (!params.get("state") && url.hash) for (const [k, v] of new URLSearchParams(url.hash.slice(1))) params.set(k, v);
    const state = params.get("state");
    const p = Array.from(this.pending.values()).find((x) => x.state === state);
    if (!p) return null;
    this.pending.delete(p.id);
    const error = params.get("error");
    if (error) p.reject(new Error(params.get("error_description") ?? error));
    else {
      const code = params.get("code");
      if (code) p.resolve(code);
      else p.reject(new Error("The OAuth redirect carried no authorization code"));
    }
    return p.id;
  }
}
