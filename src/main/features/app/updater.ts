/** Periodic GitHub Releases check plus the install flow. Network calls happen only when a feed is set. */
import { fetchLatestRelease, parseFeed, pickUpdate, type FetchLike, type UpdateCandidate } from "./releases";
import { installUpdate, type InstallPhase } from "./installer";

export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 15_000;
const FEED_CHANGE_DELAY_MS = 5_000;

export type UpdateStatus = "disabled" | "idle" | "checking" | "up-to-date" | "available" | "installing" | "error";

export interface UpdateState {
  status: UpdateStatus;
  currentVersion: string;
  feed: string;
  latestVersion?: string;
  releaseName?: string;
  releaseNotes?: string;
  releaseUrl?: string;
  lastChecked?: number;
  phase?: InstallPhase;
  error?: string;
}

export interface UpdaterDeps {
  currentVersion: string;
  getFeed(): string;
  getAutoCheck(): boolean;
  /** Path of the running .app, or null when not running from a packaged bundle. */
  currentAppPath(): string | null;
  workDir(): string;
  trash(p: string): Promise<void>;
  relaunch(): void;
  onChange(state: UpdateState): void;
  /** Called once per newly discovered version. */
  onAvailable(version: string): void;
  baseUrl?: string;
  fetchImpl?: FetchLike;
  log(...args: unknown[]): void;
}

export interface Updater {
  state(): UpdateState;
  check(): Promise<UpdateState>;
  install(): Promise<UpdateState>;
  /** Re-evaluate the schedule after settings changed. */
  reschedule(): void;
  dispose(): void;
}

export function createUpdater(deps: UpdaterDeps): Updater {
  let candidate: UpdateCandidate | null = null;
  let notifiedVersion: string | undefined;
  let timer: NodeJS.Timeout | undefined;
  let soon: NodeJS.Timeout | undefined;
  let lastFeed = deps.getFeed();
  const feedOf = () => parseFeed(deps.getFeed());
  let st: UpdateState = { status: feedOf() ? "idle" : "disabled", currentVersion: deps.currentVersion, feed: deps.getFeed() };

  const set = (patch: Partial<UpdateState>) => {
    st = { ...st, ...patch, feed: deps.getFeed() };
    deps.onChange(st);
  };

  const check = async (): Promise<UpdateState> => {
    const feed = feedOf();
    if (!feed) {
      candidate = null;
      set({ status: "disabled", latestVersion: undefined, error: deps.getFeed().trim() ? `"${deps.getFeed()}" is not an owner/repo feed` : undefined });
      return st;
    }
    if (st.status === "checking" || st.status === "installing") return st;
    set({ status: "checking", error: undefined });
    try {
      const release = await fetchLatestRelease(feed, { baseUrl: deps.baseUrl, fetchImpl: deps.fetchImpl, userAgent: `Glide/${deps.currentVersion}` });
      candidate = pickUpdate(release, deps.currentVersion);
      if (candidate) {
        const r = candidate.release;
        set({ status: "available", latestVersion: r.version, releaseName: r.name, releaseNotes: r.notes, releaseUrl: r.pageUrl, lastChecked: Date.now() });
        if (notifiedVersion !== r.version) {
          notifiedVersion = r.version;
          deps.onAvailable(r.version);
        }
      } else {
        set({ status: "up-to-date", latestVersion: release?.version, releaseUrl: release?.pageUrl, lastChecked: Date.now() });
      }
    } catch (err) {
      candidate = null;
      const message = err instanceof Error ? err.message : String(err);
      deps.log("update check failed:", message);
      set({ status: "error", error: message, lastChecked: Date.now() });
    }
    return st;
  };

  const install = async (): Promise<UpdateState> => {
    if (!candidate) {
      set({ status: st.status === "disabled" ? "disabled" : "error", error: "No update is available to install. Check for updates first." });
      return st;
    }
    const appPath = deps.currentAppPath();
    if (!appPath) {
      set({ status: "error", error: "Updates can only be installed into a packaged Glide.app (this is a development build)." });
      return st;
    }
    set({ status: "installing", phase: "downloading", error: undefined });
    try {
      await installUpdate({
        candidate,
        currentAppPath: appPath,
        workDir: deps.workDir(),
        trash: deps.trash,
        fetchImpl: deps.fetchImpl,
        onPhase: (phase) => set({ phase }),
      });
      set({ status: "installing", phase: "done" });
      deps.relaunch();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.log("update install failed:", message);
      set({ status: "error", phase: undefined, error: message });
    }
    return st;
  };

  const reschedule = () => {
    clearInterval(timer);
    clearTimeout(soon);
    timer = undefined;
    const feedChanged = deps.getFeed() !== lastFeed;
    lastFeed = deps.getFeed();
    if (!feedOf()) {
      candidate = null;
      if (st.status !== "disabled" || feedChanged) set({ status: "disabled", latestVersion: undefined, error: undefined });
      return;
    }
    if (feedChanged) {
      candidate = null;
      set({ status: "idle", latestVersion: undefined, error: undefined });
    }
    if (!deps.getAutoCheck()) return;
    timer = setInterval(() => void check(), CHECK_INTERVAL_MS);
    // A newly entered feed is checked shortly (debounced, so typing a feed does not fire requests).
    if (feedChanged) soon = setTimeout(() => void check(), FEED_CHANGE_DELAY_MS);
  };

  reschedule();
  const first = feedOf() && deps.getAutoCheck() ? setTimeout(() => void check(), FIRST_CHECK_DELAY_MS) : undefined;

  return {
    state: () => st,
    check,
    install,
    reschedule,
    dispose: () => {
      clearInterval(timer);
      clearTimeout(soon);
      clearTimeout(first);
    },
  };
}
