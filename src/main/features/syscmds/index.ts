/** Extra system commands (Toggle Hidden Files, Restart Finder/Dock, Log Out, …). See ./commands.ts. */
import { dialog } from "electron";
import type { ExecuteResult, ItemAction } from "@shared/ipc";
import type { SearchItem } from "@shared/types";
import { exec } from "../../util/exec";
import type { FeatureContext, FeatureModule } from "../types";
import { findSysCommand, parseDefaultsBool, READ_FALLBACK, SYS_COMMANDS, type Step, type SysCommand } from "./commands";

let ctx: FeatureContext | undefined;

async function runStep(step: Step): Promise<string> {
  const res = await exec(step.cmd, step.args, { input: step.input, timeoutMs: 20_000 });
  if (res.code !== 0 && !step.allowFail) throw new Error((res.stderr || res.stdout).trim() || `${step.cmd} exited with ${res.code}`);
  return res.stdout;
}

async function confirm(cmd: SysCommand): Promise<boolean> {
  ctx?.hideLauncher();
  const { response } = await dialog.showMessageBox({ type: "warning", buttons: ["Cancel", cmd.title], defaultId: 1, cancelId: 0, message: cmd.confirm ?? cmd.title });
  return response === 1;
}

async function run(cmd: SysCommand): Promise<ExecuteResult> {
  if (cmd.confirm && !(await confirm(cmd))) return { ok: true, hide: true };
  const current = cmd.read ? parseDefaultsBool(await runStep(cmd.read), READ_FALLBACK[cmd.id] ?? false) : undefined;
  for (const step of cmd.steps(current)) await runStep(step);
  const message = cmd.done(current);
  return { ok: true, hide: true, message: message || undefined };
}

export const feature: FeatureModule = {
  id: "syscmds",
  start(c) {
    ctx = c;
  },
  items: () =>
    SYS_COMMANDS.map(
      (c): SearchItem => ({
        id: `syscmds:${c.id}`,
        kind: "command",
        kindLabel: "System",
        title: c.title,
        subtitle: c.subtitle,
        icon: { kind: "emoji", value: c.icon },
        keywords: c.keywords,
        feature: "syscmds",
        data: { command: c.id },
      }),
    ),
  actions: (): ItemAction[] => [{ id: "run", title: "Run", shortcut: "⏎" }],
  async runAction(scored, actionId) {
    const cmd = typeof scored.item.data?.command === "string" ? findSysCommand(scored.item.data.command) : undefined;
    if (!cmd || actionId !== "run") return { ok: false, error: "Unknown command" };
    return run(cmd);
  },
};
