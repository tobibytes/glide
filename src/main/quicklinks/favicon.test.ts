import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FaviconCache, sniffImage } from "./favicon";

// A 1×1 ICO header is enough for sniffing; nothing here reaches the network (127.0.0.1 only).
const ICO = Buffer.from([0, 0, 1, 0, 1, 0, 16, 16, 0, 0, 1, 0, 32, 0, 0, 0, 0, 0, 22, 0, 0, 0]);
let server: http.Server;
let base = "";
const hits: string[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    hits.push(req.url ?? "");
    if (req.url === "/favicon.ico" && req.headers.host?.startsWith("127.0.0.1")) {
      res.writeHead(200, { "content-type": "text/plain" }); // wrong type on purpose: we sniff bytes
      res.end(ICO);
    } else {
      res.writeHead(404);
      res.end("nope");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("favicons", () => {
  it("sniffs common image formats and rejects HTML", () => {
    expect(sniffImage(ICO)).toBe("image/x-icon");
    expect(sniffImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0]))).toBe("image/png");
    expect(sniffImage(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBe("image/svg+xml");
    expect(sniffImage(Buffer.from("<!doctype html><html>"))).toBeUndefined();
  });

  it("fetches /favicon.ico from the quicklink's origin, caches it on disk, and never refetches", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glide-favicon-"));
    const file = path.join(dir, "favicons.json");
    const cache = new FaviconCache(() => file, (u, init) => fetch(u, init));
    const icon = await cache.get(`${base}/search?q={query}`);
    expect(icon).toBe(`data:image/x-icon;base64,${ICO.toString("base64")}`);
    expect(hits.filter((h) => h === "/favicon.ico")).toHaveLength(1);
    expect(await cache.get(`${base}/other`)).toBe(icon);
    expect(hits.filter((h) => h === "/favicon.ico")).toHaveLength(1);
    const reloaded = new FaviconCache(() => file, () => Promise.reject(new Error("must not fetch")));
    expect(await reloaded.get(`${base}/x`)).toBe(icon);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns null (and caches the miss) for missing icons and placeholder hosts", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glide-favicon-"));
    let calls = 0;
    const cache = new FaviconCache(
      () => path.join(dir, "f.json"),
      (u, init) => (calls++, fetch(u.replace("127.0.0.1", "localhost"), init)),
    );
    expect(await cache.get(`${base}/a`)).toBeNull();
    expect(await cache.get(`${base}/b`)).toBeNull();
    expect(calls).toBe(1);
    expect(await cache.get("{clipboard}")).toBeNull();
    expect(calls).toBe(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
