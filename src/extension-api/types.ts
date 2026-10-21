/**
 * Types for the Glide extension API (`@glide/api`).
 *
 * Two layers live here:
 *  - author-facing descriptions (View, ListItem, ActionDescriptor…) that may contain functions;
 *  - the serialisable wire model (ViewModel, ActionModel…) that crosses the process boundary,
 *    where every function is replaced by a handler id that stays in the extension process.
 */

// ---------------------------------------------------------------------------
// Author-facing model
// ---------------------------------------------------------------------------

/** An emoji ("🚀"), an http(s) image URL, a colour ("#ff8800"), or a file in the extension's `assets/` folder ("icon.png"). */
export type IconSource = string;

export interface Accessory {
  text?: string;
  /** Rendered as a pill. */
  tag?: string;
  icon?: IconSource;
  tooltip?: string;
  /** Text colour (#rrggbb). */
  color?: string;
  /** Tag colour (#rrggbb). */
  tagColor?: string;
}

export interface MetadataEntry {
  label: string;
  text: string;
  /** Optional http(s) link opened when the entry is activated. */
  link?: string;
  /** Raycast-style metadata rows (default "label"). */
  kind?: "label" | "link" | "tags" | "separator";
  icon?: IconSource;
  color?: string;
  tags?: Array<{ text: string; color?: string; icon?: IconSource }>;
}

export interface ActionOptions {
  title?: string;
  /** Display string such as "⌘D" or "⇧⌘C". */
  shortcut?: string;
  icon?: IconSource;
}

/** Navigation handle given to a pushed view's factory: re-render the pushed view or pop it. */
export interface Navigation {
  render(view: View): void;
  pop(): void;
}

export type ViewFactory = (nav: Navigation) => View | Promise<View>;

export type ActionDescriptor =
  | ({ kind: "openInBrowser"; url: string } & ActionOptions)
  | ({ kind: "copy"; text: string } & ActionOptions)
  | ({ kind: "paste"; text: string } & ActionOptions)
  | ({ kind: "push"; factory: ViewFactory } & ActionOptions)
  | ({ kind: "run"; handler: () => void | Promise<void> } & ActionOptions);

export interface ItemDetail {
  markdown: string;
  metadata?: MetadataEntry[];
  isLoading?: boolean;
}

export interface ListItem {
  /** Stable id (keeps the selection across re-renders). Defaults to the index. */
  id?: string;
  title: string;
  subtitle?: string;
  icon?: IconSource;
  accessories?: Accessory[];
  /** Extra words matched by the built-in filter. */
  keywords?: string[];
  /** Section header shown above the first item of each consecutive group. */
  section?: string;
  /** Right-hand preview shown while the item is selected. */
  detail?: ItemDetail;
  /** First action runs on ⏎, second on ⌘⏎, all of them in the ⌘K panel. */
  actions?: ActionDescriptor[];
}

export interface ListProps {
  items: ListItem[];
  searchPlaceholder?: string;
  isLoading?: boolean;
  emptyText?: string;
  /**
   * When set, Glide stops filtering locally and calls this with the search text
   * (debounced) so the command can re-render with its own results.
   */
  onSearchTextChange?: (text: string) => void | Promise<void>;
}

export interface DetailProps {
  markdown: string;
  title?: string;
  metadata?: MetadataEntry[];
  actions?: ActionDescriptor[];
  isLoading?: boolean;
}

export type FormFieldType = "text" | "password" | "textarea" | "checkbox" | "dropdown" | "date" | "datetime" | "tags" | "file" | "separator" | "description";

export interface FormField {
  id: string;
  title: string;
  type: FormFieldType;
  placeholder?: string;
  default?: string | boolean;
  required?: boolean;
  /** Dropdown options. */
  options?: Array<{ value: string; title: string }>;
  info?: string;
}

export type FormValue = string | boolean | string[];
export type FormValues = Record<string, FormValue>;

export interface FormProps {
  fields: FormField[];
  onSubmit: (values: FormValues) => void | Promise<void>;
  submitTitle?: string;
  description?: string;
  isLoading?: boolean;
}

export type ListView = { type: "list" } & ListProps;
export type DetailView = { type: "detail" } & DetailProps;
export type FormView = { type: "form" } & FormProps;
export type View = ListView | DetailView | FormView;

export interface ToastOptions {
  style?: "success" | "failure" | "animated";
  title: string;
  message?: string;
}

export interface Environment {
  extensionName: string;
  extensionTitle: string;
  commandName: string;
  commandMode: "view" | "no-view";
  /** Absolute path of the extension's `assets/` folder. */
  assetsPath: string;
  /** Absolute path of the installed extension. */
  extensionPath: string;
  /** A writable directory private to this extension. */
  supportPath: string;
  glideVersion: string;
}

export type PreferenceValues = Record<string, string | boolean>;

export interface CommandContext {
  /** Values for the command's declared arguments ("" when not given). */
  arguments: Record<string, string>;
  preferences: PreferenceValues;
  environment: Environment;
  /** Show (or replace) the command's root view. Call it again to re-render. */
  render(view: View): void;
}

// ---------------------------------------------------------------------------
// Wire model (serialisable)
// ---------------------------------------------------------------------------

/** Raycast-compatible views add open/showInFinder/trash/submit. */
export type ActionKind = ActionDescriptor["kind"] | "open" | "showInFinder" | "trash" | "submit";

export interface ActionModel {
  /** Unique within one rendered view. */
  id: string;
  kind: ActionKind;
  title: string;
  shortcut?: string;
  icon?: IconSource;
  url?: string;
  text?: string;
  /** Handler id for push/run/submit actions. */
  handler?: string;
  /** open / showInFinder: a URL or file path. */
  target?: string;
  /** open: application name, path or bundle id. */
  application?: string;
  /** trash: file paths. */
  paths?: string[];
  /** ActionPanel.Section / Submenu title. */
  section?: string;
  destructive?: boolean;
  /** Handler invoked after a built-in effect (onCopy, onOpen, onTrash…). */
  callback?: string;
  /** copy: the content also carries HTML. */
  html?: string;
}

export interface ListItemModel {
  id: string;
  title: string;
  subtitle?: string;
  icon?: IconSource;
  accessories: Accessory[];
  keywords: string[];
  section?: string;
  detail?: ItemDetail;
  actions: ActionModel[];
}

export interface GridItemModel {
  id: string;
  title?: string;
  subtitle?: string;
  /** Image (url / asset / emoji / #colour). */
  content: IconSource;
  tooltip?: string;
  keywords: string[];
  section?: string;
  accessoryIcon?: IconSource;
  actions: ActionModel[];
}

export interface OptionModel {
  value: string;
  title: string;
  icon?: IconSource;
  section?: string;
}

/** List/Grid searchBarAccessory dropdown. */
export interface DropdownModel {
  tooltip?: string;
  value?: string;
  /** onChange(value) */
  handler?: string;
  options: OptionModel[];
}

export interface EmptyViewModel {
  title?: string;
  description?: string;
  icon?: IconSource;
  actions: ActionModel[];
}

export interface FormFieldModel {
  id: string;
  title: string;
  type: FormFieldType;
  placeholder?: string;
  default?: FormValue;
  required: boolean;
  options: OptionModel[];
  info?: string;
  /** Controlled value (Raycast `value`). */
  value?: FormValue;
  error?: string;
  /** onChange(value) */
  changeHandler?: string;
  /** onBlur(value) */
  blurHandler?: string;
  /** file: allow several paths; also directories when `directories`. */
  multiple?: boolean;
  directories?: boolean;
  /** description fields */
  text?: string;
  autoFocus?: boolean;
}

/** Options shared by List and Grid (Raycast-compatible extras are optional). */
export interface CollectionOptions {
  searchPlaceholder?: string;
  isLoading: boolean;
  emptyText?: string;
  searchHandler?: string;
  /** Filter locally (default: true unless searchHandler is set). */
  filtering?: boolean;
  /** Controlled search text. */
  searchText?: string;
  dropdown?: DropdownModel;
  pagination?: { hasMore: boolean; handler?: string };
  /** onSelectionChange(id | null) */
  selectionHandler?: string;
  emptyView?: EmptyViewModel;
  /** Actions shown when the list is empty. */
  actions?: ActionModel[];
  title?: string;
}

export type ViewModel =
  | ({ type: "list"; items: ListItemModel[]; showDetail?: boolean } & CollectionOptions)
  | ({ type: "grid"; items: GridItemModel[]; columns: number; aspectRatio: string; fit: "contain" | "fill"; inset?: "sm" | "md" | "lg" } & CollectionOptions)
  | { type: "detail"; markdown: string; title?: string; metadata: MetadataEntry[]; actions: ActionModel[]; isLoading: boolean }
  | { type: "form"; fields: FormFieldModel[]; submitHandler?: string; submitTitle: string; description?: string; isLoading: boolean; actions?: ActionModel[]; title?: string };

export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

export type RequestMethod =
  | "clipboard.copy"
  | "clipboard.paste"
  | "clipboard.read"
  | "open"
  | "showHUD"
  | "showToast"
  | "closeMainWindow"
  | "storage.get"
  | "storage.set"
  | "storage.remove"
  | "storage.all"
  | "storage.clear"
  | "toast.hide"
  | "clipboard.clear"
  | "confirmAlert"
  | "launchCommand"
  | "selection.text"
  | "showInFinder"
  | "trash"
  | "popToRoot"
  | "clearSearchBar"
  | "openPreferences";

export interface InitPayload {
  commandPath: string;
  apiPath: string;
  /** "raycast": the command is a React component written against @raycast/api. */
  runtime?: "glide" | "raycast";
  /** raycast: directory with the react / @raycast/api / @raycast/utils shims. */
  shimDir?: string;
  launchContext?: JsonValue;
  launchType?: "userInitiated" | "background";
  arguments: Record<string, string>;
  preferences: PreferenceValues;
  environment: Environment;
}

/** Extension process → main. */
export type ChildMessage =
  | { type: "render"; depth: number; view: ViewModel }
  | { type: "push"; depth: number; view: ViewModel }
  | { type: "pop"; depth: number }
  | { type: "request"; id: number; method: RequestMethod; params: JsonValue[] }
  | { type: "done" }
  | { type: "error"; message: string; stack?: string }
  | { type: "log"; level: "log" | "warn" | "error"; text: string };

/** Main → extension process. */
export type ParentMessage =
  | { type: "init"; init: InitPayload }
  | { type: "invoke"; depth: number; handler: string; args: JsonValue[] }
  | { type: "closeView"; depth: number }
  | { type: "response"; id: number; result?: JsonValue; error?: string };
