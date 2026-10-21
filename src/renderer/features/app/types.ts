/** Mirrors AppInfo / UpdateState from src/main/features/app (renderer cannot import main modules). */
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
  phase?: string;
  error?: string;
}

export interface AppInfo {
  version: string;
  packaged: boolean;
  userDataPath: string;
  appPath: string | null;
  launchAtLogin: boolean;
  updateFeed: string;
  autoCheck: boolean;
  update: UpdateState;
}

export const isUpdateState = (v: unknown): v is UpdateState => typeof v === "object" && v !== null && typeof (v as UpdateState).status === "string";
