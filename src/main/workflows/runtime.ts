import { clipboard, Notification, shell, systemPreferences } from "electron";
import type { RunLogEntry, RunResult, Workflow, WorkflowAction } from "@shared/types";
import { exec, execOk, expandHome, openApp, osascript, sleep, zsh } from "../util/exec";
import { runFeatureAction } from "./feature-actions";
import { migrateWorkflow } from "./migrate";
import { builtinVariables, evaluateCondition, substituteParams } from "./template";

const MAX_DEPTH = 5;
const SHELL_TIMEOUT_MS = 30_000;
const HTTP_TIMEOUT_MS = 20_000;
const MAX_WAIT_SECONDS = 600;

export interface RuntimeDeps {
  getWorkflow(id: string): Workflow | undefined;
  askInput(prompt: string, placeholder?: string): Promise<string | null>;
  showResult(text: string, title?: string): void;
  /** Hide the launcher so keystrokes reach the previously active app. */
  hideLauncher(): void;
}

export interface WorkflowRuntime {
  run(wf: Workflow, input?: string): Promise<RunResult>;
}

class WorkflowError extends Error {}

export function pasteFromClipboard(): Promise<void> {
  if (!systemPreferences.isTrustedAccessibilityClient(false)) {
    throw new WorkflowError("Pasting needs Accessibility permission (System Settings → Privacy & Security → Accessibility)");
  }
  return osascript('tell application "System Events" to keystroke "v" using command down').then(() => undefined);
}

function parseHeaders(raw: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) headers[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return headers;
}

export function createWorkflowRuntime(deps: RuntimeDeps): WorkflowRuntime {
  interface Ctx {
    vars: Record<string, string>;
    log: RunLogEntry[];
    depth: number;
  }

  // Each action returns the text that becomes {{result}} (and its outputVar).
  async function perform(action: WorkflowAction, p: Record<string, string>, ctx: Ctx): Promise<string | undefined> {
    switch (action.type) {
      case "openApp": {
        if (!p.app) throw new WorkflowError("No application selected");
        await openApp(p.app);
        return undefined;
      }
      case "openUrl": {
        if (!/^[a-z][a-z0-9+.-]*:/i.test(p.url ?? "")) throw new WorkflowError(`Invalid URL: ${p.url}`);
        await shell.openExternal(p.url!);
        return undefined;
      }
      case "runShell": {
        const shellPath = p.shell && p.shell.startsWith("/") ? p.shell : "/bin/zsh";
        const res =
          shellPath === "/bin/zsh"
            ? await zsh(p.command ?? "", { timeoutMs: SHELL_TIMEOUT_MS })
            : await exec(shellPath, ["-lc", p.command ?? ""], { timeoutMs: SHELL_TIMEOUT_MS });
        if (res.code !== 0) throw new WorkflowError((res.stderr || res.stdout).trim() || `exit code ${res.code}`);
        const out = res.stdout.replace(/\n$/, "");
        ctx.vars.stdout = out;
        return out;
      }
      case "runAppleScript": {
        const out = await osascript(p.script ?? "");
        ctx.vars.scriptResult = out;
        return out;
      }
      case "typeText": {
        const previous = await clipboard.readText();
        await clipboard.writeText(p.text ?? "");
        deps.hideLauncher();
        await sleep(150);
        try {
          await pasteFromClipboard();
        } finally {
          // Give the target app time to read the pasteboard before restoring it.
          setTimeout(() => void clipboard.writeText(previous), 400);
        }
        return undefined;
      }
      case "setClipboard": {
        await clipboard.writeText(p.text ?? "");
        ctx.vars.clipboard = p.text ?? "";
        return p.text ?? "";
      }
      case "getClipboard": {
        const text = await clipboard.readText();
        ctx.vars.clipboard = text;
        return text;
      }
      case "notify": {
        if (!Notification.isSupported()) throw new WorkflowError("Notifications are not supported");
        new Notification({ title: p.title || "Glide", body: p.body ?? "", silent: true }).show();
        return undefined;
      }
      case "wait": {
        const seconds = Math.min(Math.max(Number(p.seconds) || 0, 0), MAX_WAIT_SECONDS);
        await sleep(seconds * 1000);
        return undefined;
      }
      case "askInput": {
        const answer = await deps.askInput(p.prompt || "Input", p.placeholder);
        if (answer === null) throw new WorkflowError("Cancelled");
        ctx.vars.input = answer;
        return answer;
      }
      case "setVariable": {
        const name = (p.name ?? "").trim();
        if (!/^[\w.-]+$/.test(name)) throw new WorkflowError(`Invalid variable name "${name}"`);
        ctx.vars[name] = p.value ?? "";
        return p.value ?? "";
      }
      case "condition": {
        const branch = evaluateCondition(p.left ?? "", p.operator ?? "equals", p.right ?? "") ? action.then : action.else;
        await runActions(branch ?? [], ctx);
        return undefined;
      }
      case "httpRequest": {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
        try {
          const method = (p.method || "GET").toUpperCase();
          const res = await fetch(p.url ?? "", {
            method,
            headers: parseHeaders(p.headers ?? ""),
            body: method === "GET" || method === "HEAD" || !p.body ? undefined : p.body,
            signal: controller.signal,
          });
          const text = await res.text();
          ctx.vars.response = text;
          ctx.vars.status = String(res.status);
          if (!res.ok) throw new WorkflowError(`HTTP ${res.status}: ${text.slice(0, 200)}`);
          return text;
        } finally {
          clearTimeout(timer);
        }
      }
      case "runWorkflow": {
        if (ctx.depth >= MAX_DEPTH) throw new WorkflowError(`Workflow nesting deeper than ${MAX_DEPTH}`);
        const target = deps.getWorkflow(p.workflowId ?? "");
        if (!target) throw new WorkflowError(`Workflow not found: ${p.workflowId}`);
        const sub = await runWorkflow(target, p.input ?? ctx.vars.result ?? "", ctx.depth + 1);
        if (!sub.ok) throw new WorkflowError(`"${target.name}" failed: ${sub.log.find((l) => l.status === "error")?.error ?? "unknown error"}`);
        ctx.vars.workflowResult = sub.result ?? "";
        return sub.result ?? "";
      }
      case "showResult": {
        deps.showResult(p.text ?? "", p.title);
        return p.text ?? "";
      }
      case "openFile": {
        const err = await shell.openPath(expandHome(p.path ?? ""));
        if (err) throw new WorkflowError(err);
        return undefined;
      }
      case "feature": {
        const out = await runFeatureAction(p, { ...ctx.vars });
        Object.assign(ctx.vars, out.vars);
        if (out.outputVar && out.result !== undefined) ctx.vars[out.outputVar] = out.result;
        return out.result;
      }
      case "playSound": {
        const name = (p.name || "Glass").replace(/[^A-Za-z]/g, "");
        await execOk("afplay", [`/System/Library/Sounds/${name}.aiff`], { timeoutMs: 10_000 });
        return undefined;
      }
    }
  }

  async function runActions(actions: WorkflowAction[], ctx: Ctx): Promise<void> {
    for (const action of actions) {
      const startedAt = Date.now();
      if (action.disabled) {
        ctx.log.push({ actionId: action.id, type: action.type, status: "skipped", startedAt, endedAt: startedAt });
        continue;
      }
      const params = substituteParams(action.params ?? {}, ctx.vars);
      try {
        const output = await perform(action, params, ctx);
        if (output !== undefined) ctx.vars.result = output;
        ctx.log.push({ actionId: action.id, type: action.type, status: "ok", startedAt, endedAt: Date.now(), output });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.log.push({ actionId: action.id, type: action.type, status: "error", startedAt, endedAt: Date.now(), error: message });
        if (action.params?.continueOnError !== "true") throw err;
      }
    }
  }

  async function runWorkflow(stored: Workflow, input: string, depth: number): Promise<RunResult> {
    const wf = migrateWorkflow(stored);
    const ctx: Ctx = {
      vars: { ...builtinVariables(), input, clipboard: await clipboard.readText().catch(() => ""), selection: "", result: "" },
      log: [],
      depth,
    };
    let ok = true;
    try {
      await runActions(wf.actions, ctx);
    } catch {
      ok = false; // the failing entry is already in the log
    }
    return { workflowId: wf.id, ok, log: ctx.log, variables: ctx.vars, result: ctx.vars.result };
  }

  return { run: (wf, input = "") => runWorkflow(wf, input, 0) };
}
