/**
 * Type declarations for `@glide/api` — the module Glide extensions import.
 * The implementation is injected into the extension process at run time.
 */
import type {
  ActionDescriptor,
  ActionOptions,
  CommandContext,
  DetailProps,
  DetailView,
  Environment,
  FormProps,
  FormView,
  JsonValue,
  ListProps,
  ListView,
  PreferenceValues,
  ToastOptions,
  ViewFactory,
} from "./types";

export * from "./types";

/** A searchable list. Without `onSearchTextChange`, Glide filters items by title, subtitle and keywords. */
export declare function List(props: ListProps): ListView;
/** Markdown with optional metadata and actions. */
export declare function Detail(props: DetailProps): DetailView;
/** A keyboard-first form; ⌘⏎ submits. */
export declare function Form(props: FormProps): FormView;

export declare const Action: {
  OpenInBrowser(url: string, options?: ActionOptions): ActionDescriptor;
  CopyToClipboard(text: string, options?: ActionOptions): ActionDescriptor;
  Paste(text: string, options?: ActionOptions): ActionDescriptor;
  /** Push a new view; the factory receives `nav` to re-render or pop it. */
  Push(factory: ViewFactory, options?: ActionOptions): ActionDescriptor;
  Push(title: string, factory: ViewFactory, options?: ActionOptions): ActionDescriptor;
  /** Run code in the extension process when chosen. */
  Run(title: string, handler: () => void | Promise<void>, options?: Omit<ActionOptions, "title">): ActionDescriptor;
};

export declare function showToast(options: ToastOptions): Promise<void>;
export declare function showToast(title: string, message?: string): Promise<void>;
/** Hide Glide and flash a short message. */
export declare function showHUD(text: string): Promise<void>;
export declare function closeMainWindow(): Promise<void>;
/** Open a URL (http, https, mailto) or a file/folder path with its default app. */
export declare function open(target: string): Promise<void>;
export declare function getPreferenceValues<T extends PreferenceValues = PreferenceValues>(): T;

export declare const Clipboard: {
  copy(text: string): Promise<void>;
  /** Copies, hides Glide and pastes into the frontmost app (needs Accessibility permission). */
  paste(text: string): Promise<void>;
  read(): Promise<string>;
};

/** Per-extension persistent JSON storage. */
export declare const LocalStorage: {
  getItem<T extends JsonValue = JsonValue>(key: string): Promise<T | undefined>;
  setItem(key: string, value: JsonValue): Promise<void>;
  removeItem(key: string): Promise<void>;
  allItems(): Promise<Record<string, JsonValue>>;
  clear(): Promise<void>;
};

export declare const environment: Environment;
export declare const fetch: typeof globalThis.fetch;

/** The signature of a command module's default export. */
export type Command = (ctx: CommandContext) => void | Promise<void>;
