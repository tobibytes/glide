/** Dispatch of an action chosen in an extension view. Pure apart from the injected effects. */
import type { ActionModel, ViewModel } from "../../../extension-api/types";

export interface ActionEffects {
  openUrl(url: string): Promise<void>;
  copy(text: string, html?: string): Promise<void>;
  paste(text: string): Promise<void>;
  hud(text: string): void;
  /** Run a handler inside the extension process. */
  invoke(handler: string, args: unknown[]): void;
  /** Raycast Action.Open: a URL or file path, optionally with an application. */
  open?(target: string, application?: string): Promise<void>;
  showInFinder?(path: string): Promise<void>;
  trash?(paths: string[]): Promise<void>;
}

export interface ActionOutcome {
  ok: boolean;
  /** The launcher should hide (copy/paste/open). */
  hide?: boolean;
  error?: string;
}

const SAFE_URL = /^(https?:|mailto:)/i;

export function isSafeUrl(url: string): boolean {
  if (!SAFE_URL.test(url)) return false;
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

/** Actions with the ones nested in ActionPanel.Submenu, depth-first. */
function flatten(list: ActionModel[]): ActionModel[] {
  return list.flatMap((a) => (a.children?.length ? [a, ...flatten(a.children)] : [a]));
}

/** Every action of a view, including those of list items and submenus. */
export function actionsOf(view: ViewModel): ActionModel[] {
  if (view.type === "list" || view.type === "grid") {
    const items: ActionModel[] = view.type === "list" ? view.items.flatMap((i) => i.actions) : view.items.flatMap((i) => i.actions);
    return flatten([...items, ...(view.actions ?? []), ...(view.emptyView?.actions ?? [])]);
  }
  if (view.type === "detail") return flatten(view.actions);
  if (view.type === "menubar") return [];
  return flatten(view.actions ?? []);
}

export function findAction(view: ViewModel | undefined, actionId: string): ActionModel | undefined {
  return view ? actionsOf(view).find((a) => a.id === actionId) : undefined;
}

export async function dispatchAction(action: ActionModel, fx: ActionEffects): Promise<ActionOutcome> {
  const out = await builtin(action, fx);
  // Raycast callbacks (onCopy, onOpen, onTrash…) run after the built-in effect succeeded.
  if (out.ok && action.callback) fx.invoke(action.callback, []);
  return out;
}

async function builtin(action: ActionModel, fx: ActionEffects): Promise<ActionOutcome> {
  switch (action.kind) {
    case "openInBrowser": {
      const url = action.url ?? "";
      if (!isSafeUrl(url)) return { ok: false, error: `Refusing to open "${url}": only http, https and mailto links are allowed` };
      await fx.openUrl(url);
      return { ok: true, hide: true };
    }
    case "copy":
      await fx.copy(action.text ?? "", action.html);
      fx.hud("Copied to Clipboard");
      return { ok: true, hide: true };
    case "paste":
      await fx.paste(action.text ?? "");
      return { ok: true, hide: true };
    case "push":
    case "run":
      if (!action.handler) return { ok: false, error: "Action has no handler" };
      fx.invoke(action.handler, []);
      return { ok: true };
    case "open": {
      const target = (action.target ?? "").trim();
      if (!target) return { ok: false, error: "Nothing to open" };
      if (/^(javascript|data|vbscript):/i.test(target)) return { ok: false, error: `Refusing to open "${target}"` };
      if (!fx.open) return { ok: false, error: "Opening files is not available" };
      await fx.open(target, action.application);
      return { ok: true, hide: true };
    }
    case "showInFinder":
      if (!fx.showInFinder || !action.target) return { ok: false, error: "Nothing to show" };
      await fx.showInFinder(action.target);
      return { ok: true, hide: true };
    case "trash":
      if (!fx.trash || !action.paths?.length) return { ok: false, error: "Nothing to move to the Trash" };
      await fx.trash(action.paths);
      fx.hud(action.paths.length === 1 ? "Moved to Trash" : `Moved ${action.paths.length} items to Trash`);
      return { ok: true };
    case "submit":
      return { ok: false, error: "Submit actions need the form's values" };
    case "submenu":
    case "pickDate":
    case "quickLook":
    case "createSnippet":
    case "createQuicklink":
      // Handled in the launcher (nested panel, date picker, preview, prefilled form).
      return { ok: false, error: "This action runs in the launcher" };
    default:
      return { ok: false, error: `Unknown action kind` };
  }
}
