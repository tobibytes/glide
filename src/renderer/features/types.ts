import type { ComponentType, ReactNode } from "react";
import type { ViewRequest } from "@shared/ipc";

/** Passed to every launcher view (a pushed screen inside the launcher panel, like Raycast's navigation stack). */
export interface ViewProps<P = Record<string, unknown>> {
  props: P;
  /** Text in the launcher's search field while this view is on top (reset to "" on push). */
  query: string;
  setQuery(q: string): void;
  setPlaceholder(text: string): void;
  push(view: ViewRequest): void;
  /** Back to the previous view (or the root search). */
  pop(): void;
  /** Hide the launcher. */
  close(): void;
  toast(message: string, kind?: "info" | "error"): void;
}

export interface FeatureUI {
  /** Launcher views keyed by view name; addressed as "<featureId>.<name>". */
  views?: Record<string, ComponentType<ViewProps>>;
  /** A page in the Settings window sidebar. */
  settingsPage?: { title: string; icon: string; component: ComponentType };
  /** Stand-alone window routes rendered at "#/<featureId>/<name>" (create them with ctx.createWindow in main). */
  windows?: Record<string, ComponentType>;
}

/** One row for <NavList>. */
export interface NavItem {
  id: string;
  /** Section header shown above the first item of each section. */
  section?: string;
}

export interface NavAction {
  id: string;
  title: string;
  shortcut?: string; // display string, e.g. "⌘⏎"
  icon?: string;
  destructive?: boolean;
  run(): void | Promise<void>;
}

export interface NavListProps<T extends NavItem> {
  items: T[];
  renderItem(item: T, selected: boolean): ReactNode;
  /** Enter (modifiers carry ⌘/⇧/⌥). */
  onActivate(item: T, modifiers: { cmd: boolean; shift: boolean; alt: boolean }): void;
  /** Actions for ⌘K; the first is primary (Enter), one with shortcut "⌘⏎" is secondary. */
  actions?(item: T): NavAction[];
  /** Right-hand preview pane (clipboard history, emoji, files). */
  detail?(item: T): ReactNode;
  onSelectionChange?(item: T | null): void;
  emptyText?: string;
  /** Keep the selected id across item updates (default true). */
  preserveSelection?: boolean;
}
