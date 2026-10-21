import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  timeoutMs?: number;
  input?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/** Spawn without a shell; rejects on spawn error or timeout, resolves on any exit code. */
export function exec(cmd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, opts.timeoutMs)
      : undefined;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => (stdout += d));
    child.stderr.on("data", (d: string) => (stderr += d));
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (timedOut) reject(new Error(`${cmd} timed out after ${opts.timeoutMs} ms`));
      else resolve({ code, stdout, stderr });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(opts.input ?? "");
  });
}

/** Like exec but throws when the exit code is non-zero; returns trimmed stdout. */
export async function execOk(cmd: string, args: string[], opts: ExecOptions = {}): Promise<string> {
  const res = await exec(cmd, args, opts);
  if (res.code !== 0) {
    const detail = (res.stderr || res.stdout).trim();
    throw new Error(detail ? `${cmd} failed: ${detail}` : `${cmd} exited with code ${res.code}`);
  }
  return res.stdout.trim();
}

export function osascript(script: string, opts: ExecOptions = {}): Promise<string> {
  return execOk("osascript", ["-"], { timeoutMs: 30_000, ...opts, input: script });
}

export function zsh(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
  return exec("/bin/zsh", ["-lc", command], { timeoutMs: 30_000, ...opts });
}

export function openApp(nameOrPath: string): Promise<string> {
  return execOk("open", ["-a", nameOrPath], { timeoutMs: 15_000 });
}

export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Escape a string for inclusion inside an AppleScript double-quoted literal. */
export function asString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
