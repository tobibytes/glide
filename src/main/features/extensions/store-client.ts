/** Network side of the store: fetch the index and download packages, with size limits and SHA-256 checks. */
import crypto from "node:crypto";
import { MAX_DOWNLOAD_BYTES, resolveStoreUrl, StoreIndexError, validateIndex, type IndexValidation, type StoreDownload } from "./store-schema";

export const DEFAULT_STORE_URL = "https://raw.githubusercontent.com/tobibytes/glide/main/store/index.json";
const MAX_INDEX_BYTES = 5 * 1024 * 1024;

export type Fetcher = (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<Response>;

/** Read a response body, aborting as soon as it exceeds `max` bytes. */
async function readLimited(res: Response, max: number): Promise<Buffer> {
  const declared = Number(res.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > max) throw new StoreIndexError(`Response is too large (${declared} bytes)`);
  if (!res.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw new StoreIndexError(`Response is larger than expected (> ${max} bytes)`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

function checkFinalUrl(res: Response) {
  // fetch follows redirects; the final hop must satisfy the same scheme rules.
  if (res.url) resolveStoreUrl(res.url);
}

export async function fetchStoreIndex(url: string, opts: { fetcher?: Fetcher; timeoutMs?: number } = {}): Promise<IndexValidation> {
  const u = resolveStoreUrl(url);
  const f = opts.fetcher ?? (fetch as Fetcher);
  let res: Response;
  try {
    res = await f(u.href, { signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000), headers: { accept: "application/json" } });
  } catch (err) {
    throw new StoreIndexError(`Could not reach the store (${err instanceof Error ? err.message : String(err)})`);
  }
  if (!res.ok) throw new StoreIndexError(`Store index request failed: HTTP ${res.status}`);
  checkFinalUrl(res);
  const body = await readLimited(res, MAX_INDEX_BYTES);
  let json: unknown;
  try {
    json = JSON.parse(body.toString("utf8"));
  } catch {
    throw new StoreIndexError("Store index is not valid JSON");
  }
  return validateIndex(json);
}

export const sha256 = (buf: Buffer) => crypto.createHash("sha256").update(buf).digest("hex");

/** Throws unless `buf` matches the index's declared size and SHA-256. */
export function verifyDownload(buf: Buffer, d: Pick<StoreDownload, "sha256" | "size">): void {
  if (buf.length !== d.size) throw new StoreIndexError(`Download size mismatch: expected ${d.size} bytes, got ${buf.length}. The package was not installed.`);
  const got = sha256(buf);
  if (got !== d.sha256.toLowerCase()) throw new StoreIndexError(`Checksum mismatch: expected sha256 ${d.sha256}, got ${got}. The package was not installed.`);
}

/** Download a package (relative URLs resolve against the index URL) and verify it. */
export async function downloadPackage(d: StoreDownload, indexUrl: string, opts: { fetcher?: Fetcher; timeoutMs?: number } = {}): Promise<Buffer> {
  const u = resolveStoreUrl(d.url, indexUrl);
  const f = opts.fetcher ?? (fetch as Fetcher);
  let res: Response;
  try {
    res = await f(u.href, { signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000), headers: { accept: "application/gzip, application/octet-stream" } });
  } catch (err) {
    throw new StoreIndexError(`Download failed (${err instanceof Error ? err.message : String(err)})`);
  }
  if (!res.ok) throw new StoreIndexError(`Download failed: HTTP ${res.status}`);
  checkFinalUrl(res);
  const buf = await readLimited(res, Math.min(d.size, MAX_DOWNLOAD_BYTES));
  verifyDownload(buf, d);
  return buf;
}

/** Fetch a screenshot for the details pane as a data: URL (the renderer's CSP only allows https images). */
export async function fetchImageDataUrl(url: string, base: string, opts: { fetcher?: Fetcher } = {}): Promise<string> {
  const u = resolveStoreUrl(url, base);
  const f = opts.fetcher ?? (fetch as Fetcher);
  const res = await f(u.href, { signal: AbortSignal.timeout(10_000), headers: { accept: "image/*" } });
  if (!res.ok) throw new StoreIndexError(`Image request failed: HTTP ${res.status}`);
  checkFinalUrl(res);
  const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (!/^image\/(png|jpeg|gif|webp)$/.test(type)) throw new StoreIndexError(`Not a supported image type: ${type || "unknown"}`);
  const buf = await readLimited(res, 4 * 1024 * 1024);
  return `data:${type};base64,${buf.toString("base64")}`;
}
