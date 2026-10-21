import fs from "node:fs";
import path from "node:path";
import type { KeyStatus } from "./types";

/** Subset of Electron's safeStorage, injected so the store is testable without Electron. */
export interface Cipher {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

/**
 * The API key lives only in <dataDir>/key.bin, encrypted with the OS keychain via safeStorage.
 * Nothing in this class returns the key except `read()`, which is only called by the main-process
 * client factory — never exposed as a feature method.
 */
export class KeyStore {
  private cache: string | null | undefined;

  constructor(
    private readonly dir: () => string,
    private readonly cipher: Cipher,
  ) {}

  private file(): string {
    return path.join(this.dir(), "key.bin");
  }

  status(): KeyStatus {
    let hasKey = false;
    try {
      hasKey = fs.statSync(this.file()).size > 0;
    } catch {
      hasKey = false;
    }
    return { hasKey, encryptionAvailable: this.cipher.isEncryptionAvailable() };
  }

  /** Stores the key; returns status only. Refuses to write plaintext when encryption is unavailable. */
  set(key: unknown): KeyStatus {
    if (typeof key !== "string") throw new Error("API key must be text");
    const trimmed = key.trim();
    if (!trimmed) return this.clear();
    if (trimmed.length > 512 || /\s/.test(trimmed)) throw new Error("That doesn't look like an API key");
    if (!this.cipher.isEncryptionAvailable()) throw new Error("Secure storage is unavailable on this system, so the key can't be saved");
    fs.mkdirSync(this.dir(), { recursive: true });
    fs.writeFileSync(this.file(), this.cipher.encryptString(trimmed), { mode: 0o600 });
    this.cache = trimmed;
    return this.status();
  }

  clear(): KeyStatus {
    try {
      fs.unlinkSync(this.file());
    } catch {
      /* already gone */
    }
    this.cache = null;
    return this.status();
  }

  /** Main-process only. */
  read(): string | null {
    if (this.cache !== undefined) return this.cache;
    let buf: Buffer;
    try {
      buf = fs.readFileSync(this.file());
    } catch {
      return (this.cache = null);
    }
    if (!buf.length || !this.cipher.isEncryptionAvailable()) return (this.cache = null);
    try {
      return (this.cache = this.cipher.decryptString(buf));
    } catch {
      // Keychain access denied (macOS asks once per app signature): don't cache, so the next use asks again.
      return null;
    }
  }
}
