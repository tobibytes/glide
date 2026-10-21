import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runScriptFile } from "./runner";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glide-scripts-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
const write = (name: string, body: string, mode = 0o644) => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, body, { mode });
  return p;
};
const opts = { timeoutMs: 5_000, envPath: process.env.PATH ?? "/usr/bin:/bin" };

describe("runScriptFile", () => {
  it("runs via the shebang, passes arguments and makes the file executable", async () => {
    const file = write("hello.sh", '#!/bin/bash\necho "hi $1"\necho oops >&2\n');
    const chunks: string[] = [];
    const out = await runScriptFile(file, ["there"], { ...opts, onChunk: (_s, t) => chunks.push(t) }).done;
    expect(out.code).toBe(0);
    expect(out.stdout).toBe("hi there\n");
    expect(out.stderr).toBe("oops\n");
    expect(chunks.join("")).toContain("hi there");
    expect(fs.statSync(file).mode & 0o100).toBeTruthy();
  });

  it("falls back to zsh when there is no shebang", async () => {
    const file = write("plain.sh", "echo plain\n");
    const out = await runScriptFile(file, [], opts).done;
    expect(out.stdout.trim()).toBe("plain");
  });

  it("reports non-zero exit codes", async () => {
    const file = write("fail.sh", "#!/bin/sh\necho bad >&2\nexit 3\n");
    const out = await runScriptFile(file, [], opts).done;
    expect(out.code).toBe(3);
  });

  it("enforces the timeout", async () => {
    const file = write("slow.sh", "#!/bin/sh\nsleep 5\n");
    const out = await runScriptFile(file, [], { ...opts, timeoutMs: 300 }).done;
    expect(out.timedOut).toBe(true);
    expect(out.error).toMatch(/Timed out/);
  });
});
