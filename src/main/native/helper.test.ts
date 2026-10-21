import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHelperClient, type HelperChild } from "./helper";

/** A fake helper process: we read what the client writes and answer on stdout. */
class FakeChild extends EventEmitter implements HelperChild {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly received: Array<{ id: number; method: string; params?: unknown }> = [];
  killed = false;
  stdinEnded = false;
  private partial = "";

  constructor(private readonly autoPing = true) {
    super();
    this.stdin.setEncoding("utf8");
    this.stdin.on("data", (chunk: string) => {
      this.partial += chunk;
      let nl: number;
      while ((nl = this.partial.indexOf("\n")) >= 0) {
        const msg = JSON.parse(this.partial.slice(0, nl)) as { id: number; method: string; params?: unknown };
        this.partial = this.partial.slice(nl + 1);
        this.received.push(msg);
        if (msg.method === "ping" && this.autoPing) this.reply(msg.id, { version: "test" });
      }
    });
    this.stdin.on("finish", () => (this.stdinEnded = true));
  }

  reply(id: number, result: unknown) {
    this.stdout.write(JSON.stringify({ id, result }) + "\n");
  }
  raw(text: string) {
    this.stdout.write(text);
  }
  last(method: string) {
    return [...this.received].reverse().find((m) => m.method === method);
  }
  kill() {
    this.killed = true;
    this.exit(null, "SIGTERM");
    return true;
  }
  exit(code: number | null, signal: NodeJS.Signals | null = null) {
    this.emit("exit", code, signal);
  }
}

const flush = () => new Promise((r) => setImmediate(r));

describe("native helper client", () => {
  let children: FakeChild[];
  const make = (extra: Partial<Parameters<typeof createHelperClient>[0]> = {}) =>
    createHelperClient({
      binaryPath: "/fake/glide-helper",
      exists: () => true,
      spawn: () => {
        const c = new FakeChild();
        children.push(c);
        return c;
      },
      log: () => undefined,
      ...extra,
    });

  beforeEach(() => {
    children = [];
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("becomes available after ping and correlates out-of-order responses by id", async () => {
    const h = make();
    expect(h.available()).toBe(false);
    await flush();
    await flush();
    expect(h.available()).toBe(true);

    const a = h.call("app.frontmost");
    const b = h.call("windows.apply", { action: "left-half" });
    await flush();
    const child = children[0]!;
    const reqA = child.last("app.frontmost")!;
    const reqB = child.last("windows.apply")!;
    expect(reqB.params).toEqual({ action: "left-half" });
    expect(reqA).not.toHaveProperty("params");
    child.reply(reqB.id, { ok: true });
    child.reply(reqA.id, { name: "Safari", bundleId: "com.apple.Safari", pid: 1, path: null });
    await expect(b).resolves.toEqual({ ok: true });
    await expect(a).resolves.toMatchObject({ name: "Safari" });
    h.dispose();
  });

  it("reassembles lines split across chunks (including multibyte text) and emits events", async () => {
    const h = make();
    await flush();
    const child = children[0]!;
    const seen: unknown[] = [];
    h.on("snippet.expanded", (d) => seen.push(d));
    const p = h.call("selection.text");
    await flush();
    const id = child.last("selection.text")!.id;
    const line = JSON.stringify({ id, result: { text: "héllo 👋" } }) + "\n" + JSON.stringify({ event: "snippet.expanded", data: { keyword: ";sig" } }) + "\n";
    const bytes = Buffer.from(line, "utf8");
    const cut = bytes.indexOf(0xf0) + 2; // split inside the emoji's UTF-8 sequence
    child.stdout.write(bytes.subarray(0, cut));
    await flush();
    child.stdout.write(bytes.subarray(cut));
    await expect(p).resolves.toEqual({ text: "héllo 👋" });
    expect(seen).toEqual([{ keyword: ";sig" }]);
    h.dispose();
  });

  it("rejects with the helper's error message and ignores garbage lines", async () => {
    const h = make();
    await flush();
    const child = children[0]!;
    const p = h.call("calendar.events", { from: "a", to: "b" });
    await flush();
    child.raw("not json\n\n");
    child.raw(JSON.stringify({ id: child.last("calendar.events")!.id, error: "Calendar access has not been granted" }) + "\n");
    await expect(p).rejects.toThrow("Calendar access has not been granted");
    h.dispose();
  });

  it("times out calls after the configured timeout", async () => {
    vi.useFakeTimers();
    const h = make({ timeoutMs: 10_000 });
    const p = h.call("menus.list", {});
    const assertion = expect(p).rejects.toThrow("timed out on menus.list");
    await vi.advanceTimersByTimeAsync(10_001);
    await assertion;
    h.dispose();
  });

  it("reports a clear error when the binary is missing", async () => {
    const h = make({ exists: () => false });
    expect(h.available()).toBe(false);
    await expect(h.call("ping")).rejects.toThrow(/not installed.*pnpm build:helper/);
    expect(children).toHaveLength(0);
  });

  it("restarts after a crash, rejects in-flight calls, and replays keys.configure", async () => {
    vi.useFakeTimers();
    const h = make({ restartDelayMs: 100 });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.available()).toBe(true);
    const config = { snippets: [{ keyword: ";sig", text: "Best" }], hyperKey: "off" as const };
    const configured = h.call("keys.configure", config);
    await vi.advanceTimersByTimeAsync(0);
    children[0]!.reply(children[0]!.last("keys.configure")!.id, { ok: true });
    await configured;

    const inflight = h.call("menus.list", {});
    const assertion = expect(inflight).rejects.toThrow(/exited/);
    children[0]!.exit(1);
    await assertion;
    expect(h.available()).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(children).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.available()).toBe(true);
    expect(children[1]!.last("keys.configure")?.params).toEqual(config);
    h.dispose();
  });

  it("stops restarting after 5 crashes in a minute", async () => {
    vi.useFakeTimers();
    const h = make({ restartDelayMs: 10 });
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 8; i++) {
      children[children.length - 1]!.exit(1);
      await vi.advanceTimersByTimeAsync(10 * 2 ** 5);
    }
    expect(children).toHaveLength(6); // first spawn + 5 restarts
    await vi.advanceTimersByTimeAsync(60_000);
    expect(children.length).toBeGreaterThan(6);
    h.dispose();
  });

  it("dispose closes stdin (EOF) and rejects pending calls", async () => {
    const h = make();
    await flush();
    const p = h.call("menus.list", {});
    h.dispose();
    await expect(p).rejects.toThrow(/shut down/);
    await flush();
    expect(children[0]!.stdinEnded).toBe(true);
    await expect(h.call("ping")).rejects.toThrow(/shut down/);
    expect(h.available()).toBe(false);
  });
});
