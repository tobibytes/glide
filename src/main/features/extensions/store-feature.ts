/** Wires the StoreService into the extensions feature: Electron paths, settings and renderer methods. */
import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import type { FeatureContext } from "../types";
import { readManifest, type ExtensionRegistry } from "./registry";
import { DEFAULT_STORE_URL } from "./store-client";
import type { StoreInstallResult, StoreState } from "./store-contract";
import { StoreService } from "./store-service";

export interface StoreHost {
  registry(): ExtensionRegistry;
  ctx(): FeatureContext | null;
  examplesDir(): string | undefined;
  changed(): void;
  /** Stop running sessions of an extension before its files go away. */
  beforeUninstall(name: string): void;
}

/** Settings value, then GLIDE_STORE_URL (tests / self-hosting), then the public index. */
export function storeIndexUrl(ctx: FeatureContext | null): string {
  const configured = String(ctx?.settings({ storeUrl: "" }).storeUrl ?? "").trim();
  return configured || process.env.GLIDE_STORE_URL?.trim() || DEFAULT_STORE_URL;
}

function localIndexPath(): string | undefined {
  const appPath = app.getAppPath();
  return [path.join(appPath, "store", "index.json"), path.join(appPath, "dist", "store", "index.json"), path.join(process.resourcesPath ?? "", "store", "index.json")].find((p) => fs.existsSync(p));
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

export function storeMethods(host: StoreHost): Record<string, (...args: unknown[]) => unknown> {
  let service: StoreService | null = null;
  const svc = () => {
    const ctx = host.ctx();
    if (!ctx) throw new Error("Extensions are not ready yet");
    service ??= new StoreService({
      registry: () => host.registry(),
      readManifest,
      dataDir: () => ctx.dataDir(),
      examplesDir: () => host.examplesDir(),
      localIndexPath,
      indexUrl: () => storeIndexUrl(host.ctx()),
      // Automated (headless) runs must never reach the public index; they point GLIDE_STORE_URL at 127.0.0.1.
      mayFetch: (url) => (process.env.GLIDE_HEADLESS === "1" && url === DEFAULT_STORE_URL ? "The public store index is not fetched in headless mode" : null),
      appVersion: () => app.getVersion(),
      changed: () => host.changed(),
      beforeUninstall: (name) => host.beforeUninstall(name),
      log: (...a) => ctx.log(...a),
    });
    return service;
  };
  return {
    /** The store listing. Network only here (opening the store / Refresh), never in the background. */
    storeList: (refresh: unknown): Promise<StoreState> => svc().list(refresh === true),
    storeInstall: (id: unknown, confirmed: unknown): Promise<StoreInstallResult> => svc().install(str(id), confirmed === true, "install"),
    storeUpdate: (id: unknown, confirmed: unknown): Promise<StoreInstallResult> => svc().install(str(id), confirmed === true, "update"),
    storeUninstall: (id: unknown) => svc().uninstall(str(id)),
    storeScreenshot: (id: unknown, url: unknown): Promise<string> => svc().screenshot(str(id), str(url)),
  };
}
