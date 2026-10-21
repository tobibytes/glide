/** Runs one script file with its shebang (no shell), streaming output and enforcing a timeout. */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { exec } from "../../util/exec";

export interface RunHandle {
  child: ChildProcess;
  done: Promise<RunOutcome>;
  stop(): void;
}

export interface RunOutcome {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error?: string;
}

const MAX_BUFFER = 1 << 20;
let loginPath: string | null = null;

/** PATH of a login zsh, so scripts see Homebrew etc. like they would in Terminal. */
export async function resolveLoginPath(): Promise<string> {
  if (loginPath) return loginPath;
  try {
    const res = await exec("/bin/zsh", ["-lc", 'printf %s "$PATH"'], { timeoutMs: 5_000 });
    loginPath = res.stdout.trim() || process.env.PATH || "";
  } catch {
    loginPath = process.env.PATH ?? "";
  }
  const extra = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  const parts = loginPath.split(":").filter(Boolean);
  for (const p of extra) if (!parts.includes(p)) parts.push(p);
  loginPath = parts.join(":");
  return loginPath;
}

export function ensureExecutable(file: string): void {
  const st = fs.statSync(file);
  if ((st.mode & 0o100) === 0) fs.chmodSync(file, st.mode | 0o755);
}

export function runScriptFile(file: string, args: string[], opts: { cwd?: string; timeoutMs: number; envPath: string; onChunk?(stream: "stdout" | "stderr", text: string): void }): RunHandle {
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  const env = { ...process.env, PATH: opts.envPath, GLIDE: "1", RAYCAST: "1" };
  const cwd = opts.cwd ?? path.dirname(file);

  // detached = own process group, so a timeout/stop also kills the script's children (e.g. `sleep`).
  const spawnOpts = { cwd, env, stdio: ["ignore", "pipe", "pipe"] as ("ignore" | "pipe")[], detached: true };
  const start = (useShell: boolean): ChildProcess => {
    if (useShell) return spawn("/bin/zsh", [file, ...args], spawnOpts);
    try {
      return spawn(file, args, spawnOpts);
    } catch (err) {
      // No shebang / not executable: some Node versions throw synchronously.
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOEXEC" || code === "EACCES") return spawn("/bin/zsh", [file, ...args], spawnOpts);
      throw err;
    }
  };
  const kill = (signal: NodeJS.Signals) => {
    try {
      if (child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      child.kill(signal);
    }
  };

  let child: ChildProcess;
  try {
    ensureExecutable(file);
  } catch {
    // Unwritable file: the zsh fallback below still runs it.
  }
  child = start(false);

  const done = new Promise<RunOutcome>((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    const wire = (c: ChildProcess, allowFallback: boolean) => {
      c.stdout?.setEncoding("utf8");
      c.stderr?.setEncoding("utf8");
      c.stdout?.on("data", (d: string) => {
        if (stdout.length < MAX_BUFFER) stdout += d;
        opts.onChunk?.("stdout", d);
      });
      c.stderr?.on("data", (d: string) => {
        if (stderr.length < MAX_BUFFER) stderr += d;
        opts.onChunk?.("stderr", d);
      });
      c.on("error", (err: NodeJS.ErrnoException) => {
        if (c !== child) return;
        // No shebang / not executable: run it through zsh instead.
        if (allowFallback && (err.code === "ENOEXEC" || err.code === "EACCES")) {
          child = start(true);
          wire(child, false);
          return;
        }
        clearTimeout(timer);
        resolve({ code: null, stdout, stderr, timedOut, error: err.message });
      });
      c.on("close", (code) => {
        if (c !== child) return; // replaced by the zsh fallback
        clearTimeout(timer);
        resolve({ code, stdout, stderr, timedOut, error: timedOut ? `Timed out after ${Math.round(opts.timeoutMs / 1000)} s` : undefined });
      });
    };
    wire(child, true);
    timer = setTimeout(() => {
      timedOut = true;
      kill("SIGTERM");
      setTimeout(() => kill("SIGKILL"), 2_000).unref();
    }, opts.timeoutMs);
  });

  return { get child() { return child; }, done, stop: () => kill("SIGTERM") } as RunHandle;
}
