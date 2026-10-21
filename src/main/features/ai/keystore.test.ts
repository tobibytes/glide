import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeyStore, type Cipher } from "./keystore";

const SECRET = "sk-ant-test-0000000000000000000000";

// Reversible fake "encryption" so the test can tell plaintext from ciphertext.
const fakeCipher = (available = true): Cipher => ({
  isEncryptionAvailable: () => available,
  encryptString: (s) => Buffer.from(`ENC:${Buffer.from(s).toString("base64")}`),
  decryptString: (b) => Buffer.from(b.toString().slice(4), "base64").toString(),
});

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "glide-ai-key-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("KeyStore", () => {
  it("stores the key encrypted in key.bin and only reports status", () => {
    const ks = new KeyStore(() => dir, fakeCipher());
    expect(ks.status()).toEqual({ hasKey: false, encryptionAvailable: true });
    const st = ks.set(`  ${SECRET}\n`);
    expect(st).toEqual({ hasKey: true, encryptionAvailable: true });
    expect(JSON.stringify(st)).not.toContain(SECRET);
    const raw = fs.readFileSync(path.join(dir, "key.bin"), "utf8");
    expect(raw).not.toContain(SECRET);
    expect(new KeyStore(() => dir, fakeCipher()).read()).toBe(SECRET);
  });

  it("refuses to store plaintext when encryption is unavailable", () => {
    const ks = new KeyStore(() => dir, fakeCipher(false));
    expect(() => ks.set(SECRET)).toThrow(/Secure storage/);
    expect(fs.existsSync(path.join(dir, "key.bin"))).toBe(false);
  });

  it("clears the key", () => {
    const ks = new KeyStore(() => dir, fakeCipher());
    ks.set(SECRET);
    expect(ks.clear().hasKey).toBe(false);
    expect(ks.read()).toBeNull();
  });

  it("rejects junk", () => {
    const ks = new KeyStore(() => dir, fakeCipher());
    expect(() => ks.set("has spaces in it")).toThrow();
    expect(() => ks.set(42)).toThrow();
  });
});

// The renderer-facing feature methods must never hand the raw key back.
describe("AI feature methods", () => {
  it("never return the raw key", async () => {
    vi.resetModules();
    vi.doMock("electron", () => ({
      safeStorage: fakeCipher(),
      clipboard: { readText: async () => "", writeText: async () => undefined },
      shell: { openExternal: async () => undefined },
      systemPreferences: { isTrustedAccessibilityClient: () => false },
      Notification: class {},
    }));
    const { feature } = await import("./index");
    const settingsBag: Record<string, unknown> = {};
    feature.start!({
      id: "ai",
      dataDir: () => dir,
      settings: <T extends Record<string, unknown>>(d: T) => ({ ...d, ...settingsBag }) as T,
      setSettings: (p: Record<string, unknown>) => Object.assign(settingsBag, p),
      emit: () => undefined,
      refreshCatalogue: () => undefined,
      helper: { available: () => false },
    } as never);
    const m = feature.methods!;
    const results: unknown[] = [];
    results.push(await m.setApiKey(SECRET));
    results.push(await m.hasApiKey());
    results.push(await m.getSettings());
    results.push(await m.listCommands());
    results.push(await m.listChats());
    results.push(await m.setSettings({ model: "claude-sonnet-5-5" }));
    for (const r of results) expect(JSON.stringify(r) ?? "").not.toContain(SECRET);
    expect(fs.readFileSync(path.join(dir, "key.bin"), "utf8")).not.toContain(SECRET);
    expect(Object.keys(m)).not.toContain("getApiKey");
    vi.doUnmock("electron");
  });
});
