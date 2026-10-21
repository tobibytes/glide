import type { ScriptArgument, ScriptMode } from "./parse";

export interface ScriptInfo {
  id: string;
  file: string;
  path: string;
  title?: string;
  mode?: ScriptMode;
  icon?: string;
  packageName?: string;
  description?: string;
  arguments: ScriptArgument[];
  refreshTime?: number;
  errors: string[];
}

export interface ScriptsState {
  directory: string;
  exists: boolean;
  scripts: ScriptInfo[];
}

export interface OutputChunk {
  runId: string;
  seq: number;
  stream: "stdout" | "stderr";
  text: string;
}

export interface RunSnapshot {
  runId: string;
  scriptId: string;
  title: string;
  icon?: string;
  chunks: OutputChunk[];
  done: boolean;
  code: number | null;
  error?: string;
  startedAt: number;
  endedAt?: number;
}

export interface RunExit {
  runId: string;
  code: number | null;
  error?: string;
  endedAt: number;
}
