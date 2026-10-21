import { clipboard, dialog, shell } from "electron";
import type { ExecuteModifiers, ExecuteResult, ItemAction } from "@shared/ipc";
import type { ScoredItem, SearchItem, Workflow } from "@shared/types";
import type { SearchEngine } from "@engine/api";
import type { Catalogue } from "./catalogue";
import { findSystemCommand } from "./sources/system";
import type { Store } from "./store";
import { sleep } from "./util/exec";
import type { Windows } from "./window";
import { pasteFromClipboard, type WorkflowRuntime } from "./workflows/runtime";
import type { FeatureHost } from "./features/host";
import { extraActionsFor, quicklinkAction, runExtraAction, snippetAction } from "./quicklinks/execute-hooks";

export interface Executor {
  actionsFor(item: SearchItem): ItemAction[];
  execute(scored: ScoredItem, modifiers?: ExecuteModifiers): Promise<ExecuteResult>;
  runAction(scored: ScoredItem, actionId: string, modifiers?: ExecuteModifiers): Promise<ExecuteResult>;
  /** Catalogue item by id (FeatureContext.findItem). */
  findItem?(id: string): SearchItem | undefined;
}

export interface ExecutorDeps {
  store: Store;
  engine: SearchEngine;
  catalogue: Catalogue;
  windows: Windows;
  runtime: WorkflowRuntime;
  /** Assigned after construction (features need the executor too). */
  features?: FeatureHost;
}

const A = (id: string, title: string, shortcut?: string, extra: Partial<ItemAction> = {}): ItemAction => ({ id, title, shortcut, ...extra });
const DESTRUCTIVE = { destructive: true, shortcut: "⌃X" };
const KINDS_WITHOUT_GENERIC_ACTIONS = new Set(["calculator", "fallback"]);
const KINDS_WITHOUT_USAGE = new Set(["calculator", "fallback"]);

function specificActions(item: SearchItem, isFavorite: boolean): ItemAction[] {
  void isFavorite;
  switch (item.kind) {
    case "app":
      return [A("open", "Open", "⏎"), A("reveal", "Show in Finder", "⌘⏎"), A("copyPath", "Copy Path", "⇧⌘C")];
    case "file":
      return [A("open", "Open", "⏎"), A("reveal", "Show in Finder", "⌘⏎"), A("copyPath", "Copy Path", "⇧⌘C")];
    case "quicklink":
      return [A("open", "Open", "⏎"), A("copyUrl", "Copy URL", "⌘⏎"), A("edit", "Edit Quicklink", "⌘E"), A("delete", "Delete Quicklink", undefined, DESTRUCTIVE)];
    case "snippet":
      return [A("paste", "Paste", "⏎"), A("copy", "Copy to Clipboard", "⌘⏎"), A("edit", "Edit Snippet", "⌘E"), A("delete", "Delete Snippet", undefined, DESTRUCTIVE)];
    case "system":
      return [A("run", "Run", "⏎")];
    case "workflow":
      return [A("run", "Run Workflow", "⏎"), A("edit", "Edit Workflow", "⌘E"), A("duplicate", "Duplicate", "⌘D"), A("delete", "Delete Workflow", undefined, DESTRUCTIVE)];
    case "calculator":
      return [A("copy", "Copy Result", "⏎")];
    case "setting":
      return [A("open", "Open", "⏎")];
    case "fallback":
      return [A("open", "Open", "⏎")];
    case "command":
      return []; // feature items: actions come from the owning feature module
  }
}

function fillQuery(url: string, argument: string | undefined): string {
  return url.replace(/\{query\}/g, encodeURIComponent(argument ?? ""));
}

const fail = (error: string): ExecuteResult => ({ ok: false, error });
const done = (message?: string): ExecuteResult => ({ ok: true, hide: true, message });
const navigate = (route: string): ExecuteResult => ({ ok: true, navigate: route });

import { getLastQuery } from "./last-query";

export function createExecutor(deps: ExecutorDeps): Executor {
  const { store, engine, catalogue, windows, runtime } = deps;

  const actionsFor = (item: SearchItem): ItemAction[] => {
    const favorites = store.getData().favorites;
    const isFavorite = favorites.includes(item.id);
    const actions = deps.features?.owns(item) ? deps.features.actions(item) : specificActions(item, isFavorite);
    actions.push(...extraActionsFor(item)); // e.g. "Add as Quicklink" on bookmark rows
    if (!KINDS_WITHOUT_GENERIC_ACTIONS.has(item.kind)) {
      actions.push(
        A("favorite", isFavorite ? "Remove from Favorites" : "Add to Favorites", "⇧⌘F", { icon: isFavorite ? "💔" : "⭐" }),
        A("alias", "Set Alias…", undefined, { icon: "🏷️" }),
        A("hotkey", "Set Hotkey…", undefined, { icon: "⌨️" }),
      );
    }
    return actions;
  };

  const recordUsage = (item: SearchItem) => {
    if (KINDS_WITHOUT_USAGE.has(item.kind)) return;
    const term = getLastQuery().trim();
    engine.recordUsage(item.id, term || undefined);
    store.setUsage(engine.getUsage());
  };

  const openPath = async (p: string | undefined): Promise<ExecuteResult> => {
    if (!p) return fail("Item has no path");
    const err = await shell.openPath(p);
    return err ? fail(err) : done();
  };

  const copy = async (text: string | undefined, what: string): Promise<ExecuteResult> => {
    await clipboard.writeText(text ?? "");
    return done(`${what} copied`);
  };

  const pasteSnippet = async (text: string): Promise<ExecuteResult> => {
    await clipboard.writeText(text);
    windows.hideLauncher();
    await sleep(150);
    try {
      await pasteFromClipboard();
      return done("Pasted");
    } catch (err) {
      return done(`Copied to clipboard — ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const confirm = async (title: string, message: string): Promise<boolean> => {
    windows.hideLauncher();
    const { response } = await dialog.showMessageBox({ type: "question", buttons: ["Cancel", title], defaultId: 1, cancelId: 0, message });
    return response === 1;
  };

  const runSystem = async (item: SearchItem): Promise<ExecuteResult> => {
    const cmd = item.command ? findSystemCommand(item.command) : undefined;
    if (!cmd) return fail(`Unknown system command: ${item.command}`);
    if (cmd.confirm && !(await confirm(cmd.title, cmd.confirm))) return done();
    const message = await cmd.run();
    return done(message ?? undefined);
  };

  const runWorkflowItem = async (wf: Workflow, argument: string | undefined): Promise<ExecuteResult> => {
    windows.hideLauncher();
    const run = await runtime.run(wf, argument ?? "");
    const failure = run.log.find((l) => l.status === "error");
    return { ok: run.ok, hide: true, run, message: run.ok ? `Ran “${wf.name}”` : undefined, error: run.ok ? undefined : failure?.error ?? "Workflow failed" };
  };

  const duplicateWorkflow = (wf: Workflow): ExecuteResult => {
    const copyWf: Workflow = {
      ...wf,
      id: `wf-${Date.now().toString(36)}`,
      name: `${wf.name} Copy`,
      alias: undefined,
      hotkey: undefined,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      actions: wf.actions.map((a) => ({ ...a })),
    };
    store.saveWorkflow(copyWf);
    return navigate(`settings/workflows/${copyWf.id}`);
  };

  const runAction = async (scored: ScoredItem, actionId: string, modifiers?: ExecuteModifiers): Promise<ExecuteResult> => {
    // Prefer the live catalogue entry; dynamic items (files, calculator) only exist in the payload.
    const item = catalogue.find(scored.item.id) ?? scored.item;
    const argument = scored.argument?.trim() || undefined;
    try {
      switch (actionId) {
        case "favorite": {
          const favs = store.toggleFavorite(item.id);
          return { ok: true, message: favs.includes(item.id) ? "Added to Favorites" : "Removed from Favorites" };
        }
        case "alias":
          return navigate(`settings/aliases/${encodeURIComponent(item.id)}`);
        case "hotkey":
          return navigate(`settings/hotkeys/${encodeURIComponent(item.id)}`);
      }
      const extra = await runExtraAction(item, actionId);
      if (extra) return extra;
      if (deps.features?.owns(item)) {
        const primaryFeatureAction = deps.features.actions(item)[0]?.id;
        if (actionId === primaryFeatureAction && !item.data?.noUsage) recordUsage(item);
        return await deps.features.runAction({ ...scored, item }, actionId, modifiers);
      }
      const primary = specificActions(item, false)[0]?.id;
      if (actionId === primary || actionId === "reveal") recordUsage(item);

      switch (item.kind) {
        case "app":
        case "file":
          if (actionId === "open") return openPath(item.path);
          if (actionId === "reveal") {
            if (!item.path) return fail("Item has no path");
            shell.showItemInFolder(item.path);
            return done();
          }
          if (actionId === "copyPath") return copy(item.path, "Path");
          break;
        case "quicklink": {
          const id = item.id.replace(/^quicklink:/, "");
          if (actionId === "open" || actionId === "copyUrl") return quicklinkAction(store, item, scored, actionId);
          if (actionId === "edit") return navigate(`settings/quicklinks/${id}`);
          if (actionId === "delete") {
            store.deleteQuicklink(id);
            return { ok: true, message: "Quicklink deleted" };
          }
          break;
        }
        case "snippet": {
          const id = item.id.replace(/^snippet:/, "");
          if (actionId === "paste") return (await snippetAction(item, "paste", windows.hideLauncher)) ?? pasteSnippet(item.text ?? "");
          if (actionId === "copy") return (await snippetAction(item, "copy", windows.hideLauncher)) ?? copy(item.text, "Snippet");
          if (actionId === "edit") return navigate(`settings/snippets/${id}`);
          if (actionId === "delete") {
            store.deleteSnippet(id);
            return { ok: true, message: "Snippet deleted" };
          }
          break;
        }
        case "system":
          if (actionId === "run") return runSystem(item);
          break;
        case "workflow": {
          const wf = store.getData().workflows.find((w) => w.id === item.workflowId);
          if (!wf) return fail("Workflow not found");
          if (actionId === "run") return runWorkflowItem(wf, argument);
          if (actionId === "edit") return navigate(`settings/workflows/${wf.id}`);
          if (actionId === "duplicate") return duplicateWorkflow(wf);
          if (actionId === "delete") {
            store.deleteWorkflow(wf.id);
            return { ok: true, message: "Workflow deleted" };
          }
          break;
        }
        case "calculator":
          if (actionId === "copy") return copy(item.text, "Result");
          break;
        case "setting":
          if (actionId === "open") return navigate(item.command ?? "settings/general");
          break;
        case "fallback":
          if (actionId === "open") {
            if (!item.url) return fail("Nothing to open");
            await shell.openExternal(fillQuery(item.url, argument ?? scored.item.title));
            return done();
          }
          break;
      }
      return fail(`Action "${actionId}" is not available for ${item.kind} items`);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  };

  const execute = (scored: ScoredItem, modifiers?: ExecuteModifiers): Promise<ExecuteResult> => {
    const actions = actionsFor(scored.item);
    const chosen = (modifiers?.cmd ? actions.find((a) => a.shortcut === "⌘⏎") : undefined) ?? actions[0];
    if (!chosen) return Promise.resolve(fail("No action available"));
    return runAction(scored, chosen.id, modifiers);
  };

  return { actionsFor, execute, runAction, findItem: (id) => catalogue.find(id) };
}
