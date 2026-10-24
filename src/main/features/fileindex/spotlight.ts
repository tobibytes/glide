/**
 * Spotlight (`mdfind`) queries: the name-search fallback while the first crawl
 * runs, and `content:` queries. Glide keeps no content index of its own;
 * Spotlight's content index stands in.
 */
import { spawn, type ChildProcess } from "node:child_process";

export interface SpotlightQuery {
  /** "name" → mdfind -name; "content" → full Spotlight query (contents + metadata). */
  mode: "name" | "content";
  text: string;
  scopes?: string[];
  limit: number;
  timeoutMs: number;
}

export class Spotlight {
  private current: ChildProcess | undefined;

  cancel(): void {
    if (this.current && !this.current.killed) this.current.kill("SIGKILL");
    this.current = undefined;
  }

  run(q: SpotlightQuery): Promise<string[]> {
    return new Promise((resolve) => {
      this.cancel();
      const args: string[] = [];
      for (const s of q.scopes ?? []) args.push("-onlyin", s);
      if (q.mode === "name") args.push("-name", q.text);
      else args.push(q.text);
      let child: ChildProcess;
      try {
        child = spawn("mdfind", args, { stdio: ["ignore", "pipe", "ignore"] });
      } catch {
        resolve([]);
        return;
      }
      this.current = child;
      const lines: string[] = [];
      let buffer = "";
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (this.current === child) this.current = undefined;
        if (!child.killed) child.kill("SIGKILL");
        resolve(lines.slice(0, q.limit));
      };
      const timer = setTimeout(finish, q.timeoutMs);
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        buffer += chunk;
        const parts = buffer.split("\n");
        buffer = parts.pop() ?? "";
        for (const p of parts) if (p) lines.push(p);
        if (lines.length >= q.limit) finish();
      });
      child.on("error", finish);
      child.on("close", () => {
        if (buffer) lines.push(buffer);
        finish();
      });
    });
  }
}
