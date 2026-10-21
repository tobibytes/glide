/**
 * Host tree (from the mini React runtime) → Glide's JSON view model, for Raycast-style components.
 * Functions never cross the process boundary: they are registered with `ctx.register` and replaced
 * by handler ids that stay stable while the host node stays mounted.
 *
 * Self-contained (serialised with Function.prototype.toString into the extension runner).
 */
import type { HostNode } from "./react";
import type {
  Accessory,
  ActionModel,
  DropdownModel,
  EmptyViewModel,
  FormFieldModel,
  FormFieldType,
  FormValue,
  GridItemModel,
  ListItemModel,
  MetadataEntry,
  OptionModel,
  ViewModel,
} from "../types";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface SerializeContext {
  /** Register a function; returns a handler id stable for (uid, name). */
  register(uid: number, name: string, fn: (...args: any[]) => unknown): string;
  /** Navigation push of a React element (Action.Push). */
  push(element: unknown, onPop?: () => void): void;
  /** Decode form values from the wire for submit handlers. */
  decodeValues(values: Record<string, FormValue>): Record<string, unknown>;
  /** Decode one field value from the wire. */
  decodeValue(type: FormFieldType, value: FormValue | null | undefined): unknown;
  /** Current value of an uncontrolled dropdown (searchBarAccessory). */
  dropdownValue(uid: number, fallback: string | undefined, storeKey?: string): string | undefined;
  setDropdownValue(uid: number, value: string, storeKey?: string): void;
  /** Called once per mounted dropdown with its initial value (Raycast calls onChange on mount). */
  initialDropdown(uid: number, value: string, onChange: (v: string) => void): void;
  /** Stored form value (Form fields with storeValue). */
  storedValue(fieldId: string): FormValue | undefined;
  storeValue(fieldId: string, value: FormValue): void;
  unsupported(feature: string): void;
}

export interface SerializeResult {
  view: ViewModel | null;
  fieldTypes: Record<string, FormFieldType>;
}

export interface RaycastSerializer {
  serialize(nodes: HostNode[], ctx: SerializeContext): SerializeResult;
  toIconSource(image: unknown): string | undefined;
  colorOf(color: unknown): string | undefined;
  shortcutDisplay(shortcut: unknown): string | undefined;
  relativeDate(d: Date, now?: number): string;
  ICON_GLYPHS: Record<string, string>;
  COLORS: Record<string, string>;
}

export function createRaycastSerializer(): RaycastSerializer {
  // Raycast Icon names → glyphs Glide can draw (emoji render everywhere).
  const ICON_GLYPHS: Record<string, string> = {
    AddPerson: "👤", Airplane: "✈️", Alarm: "⏰", AlarmRinging: "⏰", AppWindow: "🪟", AppWindowGrid: "🪟", AppWindowList: "🪟", Archive: "🗄️",
    ArrowClockwise: "🔃", ArrowCounterClockwise: "🔄", ArrowDown: "⬇️", ArrowDownCircle: "⬇️", ArrowLeft: "⬅️", ArrowLeftCircle: "⬅️", ArrowNe: "↗️",
    ArrowRight: "➡️", ArrowRightCircle: "➡️", ArrowUp: "⬆️", ArrowUpCircle: "⬆️", ArrowsContract: "↘️", ArrowsExpand: "↗️", AtSymbol: "@",
    BandAid: "🩹", BankNote: "💵", BarChart: "📊", BarCode: "▥", Bell: "🔔", BellDisabled: "🔕", Bike: "🚲", Binoculars: "🔭", Bird: "🐦",
    Blank: " ", Bluetooth: "ᛒ", Boat: "⛵", Bold: "𝐁", Bolt: "⚡", BoltDisabled: "⚡", Book: "📖", Bookmark: "🔖", Box: "📦", Brush: "🖌️",
    Bubble: "💬", Bug: "🐛", Building: "🏢", BullsEye: "🎯", Calculator: "🧮", Calendar: "📅", Camera: "📷", Car: "🚗", Cart: "🛒", Cd: "💿",
    Center: "⊙", Check: "✓", CheckCircle: "✅", CheckList: "☑️", CheckRosette: "🏅", Checkmark: "✓", ChevronDown: "⌄", ChevronDownSmall: "⌄",
    ChevronLeft: "‹", ChevronLeftSmall: "‹", ChevronRight: "›", ChevronRightSmall: "›", ChevronUp: "⌃", ChevronUpSmall: "⌃", ChevronUpDown: "↕️",
    Circle: "○", CircleDisabled: "⊘", CircleEllipsis: "⋯", CircleFilled: "●", CircleProgress: "◔", CircleProgress25: "◔", CircleProgress50: "◑",
    CircleProgress75: "◕", CircleProgress100: "●", Clipboard: "📋", Clock: "🕒", Cloud: "☁️", CloudLightning: "🌩️", CloudRain: "🌧️", CloudSnow: "🌨️",
    CloudSun: "⛅", Code: "</>", CodeBlock: "⌨️", Cog: "⚙️", Coin: "🪙", Coins: "🪙", CommandSymbol: "⌘", Compass: "🧭", ComputerChip: "🖥️",
    Contrast: "◐", CopyClipboard: "📋", CreditCard: "💳", CricketBall: "🏏", Crop: "✂️", Crown: "👑", Crypto: "🪙", DeleteDocument: "🗑️",
    Desktop: "🖥️", Dna: "🧬", Document: "📄", Dot: "•", Download: "⬇️", Droplets: "💧", Duplicate: "⧉", EditShape: "✏️", Eject: "⏏️",
    Ellipsis: "⋯", Envelope: "✉️", Eraser: "🧽", ExclamationMark: "❗", Exclamationmark: "❗", Exclamationmark2: "‼️", Exclamationmark3: "‼️",
    Eye: "👁️", EyeDisabled: "🙈", EyeDropper: "💉", Female: "♀️", FilmStrip: "🎞️", Filter: "⏳", Finder: "📂", Fingerprint: "☝️", Flag: "🚩",
    Folder: "📁", Footprints: "👣", Forward: "⏩", ForwardFilled: "⏩", FountainTip: "🖋️", FullSignal: "📶", GameController: "🎮", Gauge: "⏲️",
    Gear: "⚙️", Geopin: "📍", Germ: "🦠", Gift: "🎁", Glasses: "👓", Globe: "🌐", Goal: "🥅", Hammer: "🔨", HardDrive: "💽", Hashtag: "#",
    Headphones: "🎧", Heart: "❤️", HeartDisabled: "💔", Heartbeat: "💓", Highlight: "🖍️", Hourglass: "⏳", House: "🏠", Humidity: "💧",
    Image: "🖼️", Important: "❗", Info: "ℹ️", Italics: "𝐼", Key: "🔑", Keyboard: "⌨️", Layers: "🗂️", Leaf: "🍃", LevelMeter: "📶",
    LightBulb: "💡", LightBulbOff: "💡", LineChart: "📈", Link: "🔗", List: "☰", Livestream: "📡", Lock: "🔒", LockDisabled: "🔓",
    LockUnlocked: "🔓", Logout: "🚪", Lorry: "🚚", Lowercase: "a", MagnifyingGlass: "🔍", Male: "♂️", Map: "🗺️", Mask: "🎭", Maximize: "⤢",
    MedicalSupport: "⚕️", Megaphone: "📣", MemoryChip: "💾", MemoryStick: "💾", Message: "💬", Microphone: "🎤", MicrophoneDisabled: "🎙️",
    Minimize: "⤡", Minus: "−", MinusCircle: "⊖", MinusCircleFilled: "⊖", Mobile: "📱", Monitor: "🖥️", Moon: "🌙", Mountain: "⛰️", Mouse: "🖱️",
    Multiply: "×", Music: "🎵", Network: "🌐", NewDocument: "📝", NewFolder: "📁", Paperclip: "📎", Paragraph: "¶", Pause: "⏸️",
    PauseFilled: "⏸️", Pencil: "✏️", Person: "👤", PersonCircle: "👤", PersonLines: "👥", Phone: "📞", PhoneRinging: "📲", PieChart: "🥧",
    Pill: "💊", Pin: "📌", PinDisabled: "📌", Play: "▶️", PlayFilled: "▶️", Plug: "🔌", Plus: "+", PlusCircle: "⊕", PlusCircleFilled: "⊕",
    PlusMinusDivideMultiply: "±", PlusSquare: "⊞", PlusTopRightSquare: "⊞", Power: "⏻", Print: "🖨️", QuestionMark: "?", QuestionMarkCircle: "❓",
    QuotationMarks: "❝", QuoteBlock: "❝", Racket: "🎾", Raindrop: "💧", RaycastLogoNeg: "🔺", RaycastLogoPos: "🔺", Receipt: "🧾", Redo: "↪️",
    RemovePerson: "👤", Repeat: "🔁", Replace: "🔁", ReplaceOne: "🔂", Reply: "↩️", Rewind: "⏪", RewindFilled: "⏪", Rocket: "🚀", Rosette: "🏵️",
    RotateAntiClockwise: "↺", RotateClockwise: "↻", Ruler: "📏", SaveDocument: "💾", Shield: "🛡️", ShortParagraph: "¶", Shuffle: "🔀",
    Sidebar: "▥", Signal0: "📶", Signal1: "📶", Signal2: "📶", Signal3: "📶", Snippets: "✂️", Snowflake: "❄️", SoccerBall: "⚽", Speaker: "🔈",
    SpeakerDown: "🔉", SpeakerHigh: "🔊", SpeakerOff: "🔇", SpeakerOn: "🔈", SpeakerUp: "🔊", SpeechBubble: "💬", SpeechBubbleActive: "💬",
    SpeechBubbleImportant: "💬", SquareEllipsis: "⋯", StackedBars1: "📊", StackedBars2: "📊", StackedBars3: "📊", StackedBars4: "📊", Star: "⭐",
    StarCircle: "🌟", StarDisabled: "☆", Stars: "✨", Stop: "⏹️", StopFilled: "⏹️", Stopwatch: "⏱️", Store: "🏬", StrikeThrough: "S̶", Sun: "☀️",
    Sunrise: "🌅", Swatch: "🎨", Switch: "🔀", Syringe: "💉", Tack: "📌", TackDisabled: "📌", Tag: "🏷️", Temperature: "🌡️", TennisBall: "🎾",
    Terminal: ">_", Text: "T", TextCursor: "I", TextInput: "⌨️", TextSelection: "I", Torch: "🔦", Train: "🚆", Trash: "🗑️", Tray: "📥", Tree: "🌳",
    Trophy: "🏆", TwoPeople: "👥", Umbrella: "☂️", Underline: "U̲", Undo: "↩️", Upload: "⬆️", Uppercase: "A", Video: "🎥", VideoDisabled: "🎥",
    Wallet: "👛", Wand: "🪄", Warning: "⚠️", Waveform: "〰️", Weights: "🏋️", Wifi: "📶", WifiDisabled: "📵", Wind: "💨", Window: "🪟",
    Windsock: "🎐", WrenchScrewdriver: "🛠️", Wrench: "🔧", WristWatch: "⌚", XMarkCircle: "❌", XMarkCircleFilled: "❌", XMarkTopRightSquare: "❎", Xmark: "✕",
  };
  const CIRCLES = new Set(["Circle", "CircleFilled", "Dot", "CircleProgress100"]);
  const COLORS: Record<string, string> = {
    Blue: "#3B82F6", Green: "#22C55E", Magenta: "#D946EF", Orange: "#F97316", Purple: "#A855F7", Red: "#EF4444", Yellow: "#EAB308",
    PrimaryText: "#E5E7EB", SecondaryText: "#9CA3AF",
  };

  const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !(v instanceof Date) && !Array.isArray(v);
  const str = (v: unknown): string | undefined => (v === undefined || v === null || v === false ? undefined : typeof v === "object" ? undefined : String(v));
  const fnOf = (v: unknown) => (typeof v === "function" ? (v as (...a: any[]) => unknown) : undefined);

  function colorOf(color: unknown): string | undefined {
    if (typeof color === "string") {
      if (/^raycast-/.test(color)) {
        const name = color.slice(8).replace(/(^|-)([a-z])/g, (_m, _d, c: string) => c.toUpperCase());
        return COLORS[name];
      }
      if (COLORS[color]) return COLORS[color];
      return /^#|^rgb|^hsl/i.test(color) ? color : undefined;
    }
    if (isObj(color)) return colorOf(color.dark ?? color.light ?? color.adjustContrast);
    return undefined;
  }

  function toIconSource(image: unknown): string | undefined {
    if (image === undefined || image === null || image === false) return undefined;
    if (typeof image === "string") {
      const v = image.trim();
      if (!v) return undefined;
      if (v.startsWith("rc:")) return ICON_GLYPHS[v.slice(3)] ?? "▫️";
      if (/^(https?:|file:|data:image\/)/i.test(v)) return v;
      if (v.startsWith("/") || v.startsWith("~")) return `file://${v}`;
      return v;
    }
    if (isObj(image)) {
      if (typeof image.fileIcon === "string") return `file://${image.fileIcon}`;
      if ("value" in image && !("source" in image)) return toIconSource(image.value);
      const src = isObj(image.source) ? (image.source.dark ?? image.source.light) : image.source;
      const tint = colorOf(image.tintColor);
      if (typeof src === "string" && src.startsWith("rc:") && tint && CIRCLES.has(src.slice(3))) return tint;
      const out = toIconSource(src);
      return out ?? toIconSource(image.fallback);
    }
    return undefined;
  }

  const KEY_GLYPHS: Record<string, string> = {
    return: "⏎", enter: "⏎", delete: "⌫", backspace: "⌫", deleteForward: "⌦", tab: "⇥", escape: "⎋", space: "Space",
    arrowUp: "↑", arrowDown: "↓", arrowLeft: "←", arrowRight: "→", pageUp: "⇞", pageDown: "⇟", home: "↖", end: "↘",
  };
  const MOD_GLYPHS: Record<string, string> = { ctrl: "⌃", opt: "⌥", alt: "⌥", shift: "⇧", cmd: "⌘" };
  const MOD_ORDER = ["⌃", "⌥", "⇧", "⌘"];

  function shortcutDisplay(sc: unknown): string | undefined {
    if (typeof sc === "string") return sc || undefined;
    if (!isObj(sc)) return undefined;
    if (isObj(sc.macOS)) return shortcutDisplay(sc.macOS);
    const key = typeof sc.key === "string" ? sc.key : "";
    if (!key) return undefined;
    const mods = (Array.isArray(sc.modifiers) ? sc.modifiers : [])
      .map((m: unknown) => MOD_GLYPHS[String(m)])
      .filter(Boolean)
      .sort((a: string, b: string) => MOD_ORDER.indexOf(a) - MOD_ORDER.indexOf(b));
    return mods.join("") + (KEY_GLYPHS[key] ?? key.toUpperCase());
  }

  function relativeDate(d: Date, now = Date.now()): string {
    const diff = now - d.getTime();
    const abs = Math.abs(diff);
    const m = 60_000;
    const h = 60 * m;
    const day = 24 * h;
    let s: string;
    if (abs < m) return "now";
    if (abs < h) s = `${Math.round(abs / m)}m`;
    else if (abs < day) s = `${Math.round(abs / h)}h`;
    else if (abs < 7 * day) s = `${Math.round(abs / day)}d`;
    else if (abs < 30 * day) s = `${Math.round(abs / (7 * day))}w`;
    else if (abs < 365 * day) s = `${Math.round(abs / (30 * day))}mo`;
    else s = `${Math.round(abs / (365 * day))}y`;
    return diff < 0 ? `in ${s}` : s;
  }

  const textOf = (v: unknown): { text?: string; color?: string; tooltip?: string } => {
    if (v instanceof Date) return { text: v.toLocaleString() };
    if (isObj(v)) return { text: v.value instanceof Date ? v.value.toLocaleString() : str(v.value), color: colorOf(v.color), tooltip: str(v.tooltip) };
    return { text: str(v) };
  };

  function accessory(a: unknown): Accessory | null {
    if (!isObj(a)) return null;
    const out: Accessory = {};
    if (a.text !== undefined && a.text !== null) {
      const t = textOf(a.text);
      if (t.text) out.text = t.text;
      if (t.color) out.color = t.color;
    }
    if (a.date !== undefined && a.date !== null) {
      const raw = isObj(a.date) ? a.date.value : a.date;
      const d = raw instanceof Date ? raw : new Date(raw as string);
      if (!Number.isNaN(d.getTime())) out.text = relativeDate(d);
      if (isObj(a.date) && colorOf(a.date.color)) out.color = colorOf(a.date.color);
    }
    if (a.tag !== undefined && a.tag !== null) {
      const raw = isObj(a.tag) ? a.tag.value : a.tag;
      out.tag = raw instanceof Date ? relativeDate(raw) : str(raw);
      if (isObj(a.tag) && colorOf(a.tag.color)) out.tagColor = colorOf(a.tag.color);
    }
    const icon = toIconSource(a.icon);
    if (icon) out.icon = icon;
    if (a.tooltip) out.tooltip = String(a.tooltip);
    return out.text || out.tag || out.icon ? out : null;
  }

  const hosts = (nodes: HostNode[] | undefined) => (nodes ?? []).filter((n) => n.type !== "#text");

  /** Visit host nodes depth-first, descending into unknown containers. */
  function walk(nodes: HostNode[] | undefined, visit: (n: HostNode) => boolean | void) {
    for (const n of hosts(nodes)) if (visit(n) !== true) walk(n.children, visit);
  }

  function serialize(nodes: HostNode[], ctx: SerializeContext): SerializeResult {
    const fieldTypes: Record<string, FormFieldType> = {};
    let actionSeq = 0;
    const reg = (n: HostNode, name: string, fn: ((...a: any[]) => unknown) | undefined) => (fn ? ctx.register(n.uid, name, fn) : undefined);

    function action(n: HostNode, section: string | undefined): ActionModel | null {
      const p = n.props;
      const base = (kind: ActionModel["kind"], title: string): ActionModel => {
        const m: ActionModel = { id: `a${n.uid}`, kind, title: str(p.title) ?? title };
        const sc = shortcutDisplay(p.shortcut);
        if (sc) m.shortcut = sc;
        const icon = toIconSource(p.icon);
        if (icon) m.icon = icon;
        if (section) m.section = section;
        if (p.style === "destructive") m.destructive = true;
        actionSeq++;
        return m;
      };
      const contentText = (c: unknown) => (isObj(c) ? str(c.text ?? c.file) ?? "" : str(c) ?? "");
      switch (n.type) {
        case "Action": {
          const m = base("run", "Run");
          m.handler = reg(n, "onAction", fnOf(p.onAction)) ?? ctx.register(n.uid, "noop", () => undefined);
          return m;
        }
        case "Action.CopyToClipboard": {
          const m = base("copy", "Copy to Clipboard");
          m.text = contentText(p.content);
          if (isObj(p.content) && typeof p.content.html === "string") m.html = p.content.html;
          m.callback = reg(n, "onCopy", fnOf(p.onCopy) && (() => p.onCopy(p.content)));
          return m;
        }
        case "Action.Paste": {
          const m = base("paste", "Paste");
          m.text = contentText(p.content);
          m.callback = reg(n, "onPaste", fnOf(p.onPaste) && (() => p.onPaste(p.content)));
          return m;
        }
        case "Action.OpenInBrowser": {
          const m = base("openInBrowser", "Open in Browser");
          m.url = str(p.url) ?? "";
          m.callback = reg(n, "onOpen", fnOf(p.onOpen) && (() => p.onOpen(p.url)));
          return m;
        }
        case "Action.Open":
        case "Action.OpenWith": {
          const m = base("open", n.type === "Action.OpenWith" ? "Open With" : "Open");
          m.target = str(p.target ?? p.path) ?? "";
          const app = isObj(p.application) ? (p.application.path ?? p.application.bundleId ?? p.application.name) : p.application;
          if (str(app)) m.application = str(app);
          m.callback = reg(n, "onOpen", fnOf(p.onOpen) && (() => p.onOpen(m.target)));
          return m;
        }
        case "Action.ShowInFinder": {
          const m = base("showInFinder", "Show in Finder");
          m.target = str(p.path) ?? "";
          m.callback = reg(n, "onShow", fnOf(p.onShow) && (() => p.onShow(p.path)));
          return m;
        }
        case "Action.Trash": {
          const m = base("trash", "Move to Trash");
          m.paths = (Array.isArray(p.paths) ? p.paths : [p.paths]).filter((x: unknown) => typeof x === "string");
          m.destructive = true;
          m.callback = reg(n, "onTrash", fnOf(p.onTrash) && (() => p.onTrash(p.paths)));
          return m;
        }
        case "Action.Push": {
          const m = base("push", "Show Details");
          const target = p.target;
          m.handler = ctx.register(n.uid, "push", () => {
            ctx.push(target, fnOf(p.onPop));
            p.onPush?.();
          });
          return m;
        }
        case "Action.SubmitForm": {
          const m = base("submit", "Submit Form");
          m.handler = ctx.register(n.uid, "onSubmit", (values: Record<string, FormValue>) => p.onSubmit?.(ctx.decodeValues(values ?? {})));
          return m;
        }
        case "Action.CreateSnippet":
        case "Action.CreateQuicklink":
        case "Action.ToggleQuickLook":
        case "Action.PickDate": {
          const label = n.type.slice(7);
          const m = base("run", label.replace(/([a-z])([A-Z])/g, "$1 $2"));
          m.handler = ctx.register(n.uid, "unsupported", () => ctx.unsupported(`Action.${label}`));
          return m;
        }
      }
      return null;
    }

    function actionsOf(slot: HostNode[] | undefined): ActionModel[] {
      const out: ActionModel[] = [];
      const visit = (nodes: HostNode[] | undefined, section: string | undefined) => {
        for (const n of hosts(nodes)) {
          if (n.type === "ActionPanel") visit(n.children, section);
          else if (n.type === "ActionPanel.Section") visit(n.children, str(n.props.title) ?? section);
          else if (n.type === "ActionPanel.Submenu") visit(n.children, str(n.props.title) ?? section);
          else if (n.type.startsWith("Action")) {
            const a = action(n, section);
            if (a) out.push(a);
          } else visit(n.children, section);
        }
      };
      visit(slot, undefined);
      return out;
    }

    function metadata(slot: HostNode[] | undefined): MetadataEntry[] {
      const out: MetadataEntry[] = [];
      walk(slot, (n) => {
        const p = n.props;
        if (n.type.endsWith("Metadata.Label")) {
          const t = textOf(p.text);
          const e: MetadataEntry = { kind: "label", label: str(p.title) ?? "", text: t.text ?? "" };
          if (t.color) e.color = t.color;
          const icon = toIconSource(p.icon);
          if (icon) e.icon = icon;
          out.push(e);
          return true;
        }
        if (n.type.endsWith("Metadata.Link")) {
          out.push({ kind: "link", label: str(p.title) ?? "", text: str(p.text) ?? str(p.target) ?? "", link: str(p.target) });
          return true;
        }
        if (n.type.endsWith("Metadata.TagList")) {
          const tags: NonNullable<MetadataEntry["tags"]> = [];
          walk(n.children, (t) => {
            if (!t.type.endsWith("TagList.Item")) return;
            const tag: { text: string; color?: string; icon?: string } = { text: str(t.props.text) ?? "" };
            const c = colorOf(t.props.color);
            if (c) tag.color = c;
            const icon = toIconSource(t.props.icon);
            if (icon) tag.icon = icon;
            tags.push(tag);
            return true;
          });
          out.push({ kind: "tags", label: str(p.title) ?? "", text: tags.map((t) => t.text).join(", "), tags });
          return true;
        }
        if (n.type.endsWith("Metadata.Separator")) {
          out.push({ kind: "separator", label: "", text: "" });
          return true;
        }
      });
      return out;
    }

    function options(nodes: HostNode[] | undefined): OptionModel[] {
      const out: OptionModel[] = [];
      const visit = (list: HostNode[] | undefined, section: string | undefined) => {
        for (const n of hosts(list)) {
          if (n.type.endsWith(".Section")) visit(n.children, str(n.props.title) ?? section);
          else if (n.type.endsWith(".Item")) {
            const o: OptionModel = { value: str(n.props.value) ?? "", title: str(n.props.title) ?? str(n.props.value) ?? "" };
            const icon = toIconSource(n.props.icon);
            if (icon) o.icon = icon;
            if (section) o.section = section;
            out.push(o);
          } else visit(n.children, section);
        }
      };
      visit(nodes, undefined);
      return out;
    }

    function dropdown(slot: HostNode[] | undefined): DropdownModel | undefined {
      const n = hosts(slot).find((x) => x.type.endsWith("Dropdown"));
      if (!n) return undefined;
      const p = n.props;
      const opts = options(n.children);
      const storeKey = p.storeValue && p.id ? `dropdown:${String(p.id)}` : undefined;
      const controlled = p.value !== undefined && p.value !== null;
      const value = controlled ? String(p.value) : ctx.dropdownValue(n.uid, str(p.defaultValue) ?? opts[0]?.value, storeKey);
      const onChange = fnOf(p.onChange);
      const model: DropdownModel = { options: opts, value };
      if (p.tooltip) model.tooltip = String(p.tooltip);
      model.handler = ctx.register(n.uid, "onChange", (v: string) => {
        if (!controlled) ctx.setDropdownValue(n.uid, String(v), storeKey);
        return onChange?.(String(v));
      });
      if (onChange && value !== undefined && !controlled) ctx.initialDropdown(n.uid, value, (v) => onChange(v));
      return model;
    }

    function emptyView(nodes: HostNode[] | undefined): EmptyViewModel | undefined {
      let found: HostNode | undefined;
      walk(nodes, (n) => {
        if (n.type.endsWith("EmptyView")) {
          found = n;
          return true;
        }
        if (n.type.endsWith(".Item") || n.type.endsWith(".Section")) return true;
      });
      if (!found) return undefined;
      const p = found.props;
      const ev: EmptyViewModel = { actions: actionsOf(found.slots.actions) };
      if (str(p.title)) ev.title = str(p.title);
      if (str(p.description)) ev.description = str(p.description);
      const icon = toIconSource(p.icon);
      if (icon) ev.icon = icon;
      return ev;
    }

    function collection(root: HostNode) {
      const p = root.props;
      const searchHandler = reg(root, "onSearchTextChange", fnOf(p.onSearchTextChange));
      const filtering = p.filtering === undefined ? !searchHandler : !!p.filtering;
      const out: Record<string, unknown> = { isLoading: !!p.isLoading, filtering };
      if (searchHandler) out.searchHandler = searchHandler;
      if (str(p.searchBarPlaceholder)) out.searchPlaceholder = str(p.searchBarPlaceholder);
      if (typeof p.searchText === "string") out.searchText = p.searchText;
      if (str(p.navigationTitle)) out.title = str(p.navigationTitle);
      const dd = dropdown(root.slots.searchBarAccessory);
      if (dd) out.dropdown = dd;
      if (isObj(p.pagination)) out.pagination = { hasMore: !!p.pagination.hasMore, handler: reg(root, "onLoadMore", fnOf(p.pagination.onLoadMore)) };
      const sel = reg(root, "onSelectionChange", fnOf(p.onSelectionChange) && ((id: string | null) => p.onSelectionChange(id ?? null)));
      if (sel) out.selectionHandler = sel;
      const ev = emptyView(root.children);
      if (ev) out.emptyView = ev;
      const acts = actionsOf(root.slots.actions);
      if (acts.length) out.actions = acts;
      return out;
    }

    const idOf = (n: HostNode, seen: Set<string>) => {
      let id = str(n.props.id) ?? (n.key !== null ? `k${n.key}` : `u${n.uid}`);
      while (seen.has(id)) id += "~";
      seen.add(id);
      return id;
    };

    function list(root: HostNode): ViewModel {
      const items: ListItemModel[] = [];
      const seen = new Set<string>();
      const visit = (nodes: HostNode[] | undefined, section: string | undefined) => {
        for (const n of hosts(nodes)) {
          if (n.type === "List.Section") visit(n.children, str(n.props.title) ?? section);
          else if (n.type === "List.Item") {
            const p = n.props;
            const t = textOf(p.title);
            const item: ListItemModel = { id: idOf(n, seen), title: t.text ?? "", accessories: [], keywords: [], actions: actionsOf(n.slots.actions) };
            const sub = textOf(p.subtitle).text;
            if (sub) item.subtitle = sub;
            const icon = toIconSource(p.icon);
            if (icon) item.icon = icon;
            if (Array.isArray(p.accessories)) item.accessories = p.accessories.map(accessory).filter((a: Accessory | null): a is Accessory => !!a);
            if (Array.isArray(p.keywords)) item.keywords = p.keywords.map(String);
            if (section) item.section = section;
            const d = hosts(n.slots.detail)[0];
            if (d) item.detail = { markdown: str(d.props.markdown) ?? "", metadata: metadata(d.slots.metadata), isLoading: !!d.props.isLoading };
            items.push(item);
          } else if (!n.type.endsWith("EmptyView") && !n.type.endsWith("Dropdown")) visit(n.children, section);
        }
      };
      visit(root.children, undefined);
      return { type: "list", items, showDetail: !!root.props.isShowingDetail, ...collection(root) } as ViewModel;
    }

    function grid(root: HostNode): ViewModel {
      const p = root.props;
      const items: GridItemModel[] = [];
      const seen = new Set<string>();
      const visit = (nodes: HostNode[] | undefined, section: string | undefined) => {
        for (const n of hosts(nodes)) {
          if (n.type === "Grid.Section") visit(n.children, str(n.props.title) ?? section);
          else if (n.type === "Grid.Item") {
            const q = n.props;
            const content = q.content;
            const src = isObj(content) && "color" in content ? colorOf(content.color) : toIconSource(isObj(content) && "value" in content && !("source" in content) ? content.value : content);
            const item: GridItemModel = { id: idOf(n, seen), content: src ?? "▫️", keywords: Array.isArray(q.keywords) ? q.keywords.map(String) : [], actions: actionsOf(n.slots.actions) };
            const title = textOf(q.title).text;
            if (title) item.title = title;
            const sub = textOf(q.subtitle).text;
            if (sub) item.subtitle = sub;
            if (isObj(content) && content.tooltip) item.tooltip = String(content.tooltip);
            if (isObj(q.accessory)) {
              const ai = toIconSource(q.accessory.icon);
              if (ai) item.accessoryIcon = ai;
            }
            if (section) item.section = section;
            items.push(item);
          } else if (!n.type.endsWith("EmptyView") && !n.type.endsWith("Dropdown")) visit(n.children, section);
        }
      };
      visit(root.children, undefined);
      const sizes: Record<string, number> = { small: 8, medium: 5, large: 3 };
      const columns = Math.max(1, Math.min(8, Math.round(Number(p.columns ?? sizes[String(p.itemSize)] ?? 5)) || 5));
      const inset = p.inset === "sm" || p.inset === "md" || p.inset === "lg" ? p.inset : undefined;
      return { type: "grid", items, columns, aspectRatio: str(p.aspectRatio) ?? "1", fit: p.fit === "fill" ? "fill" : "contain", ...(inset ? { inset } : {}), ...collection(root) } as ViewModel;
    }

    function detail(root: HostNode): ViewModel {
      const p = root.props;
      const v: ViewModel = { type: "detail", markdown: str(p.markdown) ?? "", metadata: metadata(root.slots.metadata), actions: actionsOf(root.slots.actions), isLoading: !!p.isLoading };
      if (str(p.navigationTitle)) v.title = str(p.navigationTitle);
      return v;
    }

    const FIELD_TYPES: Record<string, FormFieldType> = {
      "Form.TextField": "text",
      "Form.PasswordField": "password",
      "Form.TextArea": "textarea",
      "Form.Checkbox": "checkbox",
      "Form.DatePicker": "date",
      "Form.Dropdown": "dropdown",
      "Form.TagPicker": "tags",
      "Form.FilePicker": "file",
      "Form.Separator": "separator",
      "Form.Description": "description",
    };

    const encode = (type: FormFieldType, v: unknown): FormValue | undefined => {
      if (v === undefined || v === null) return undefined;
      if (type === "checkbox") return !!v;
      if (type === "tags" || type === "file") return Array.isArray(v) ? v.map(String) : [String(v)];
      if (type === "date" || type === "datetime") {
        const d = v instanceof Date ? v : new Date(v as string);
        return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
      }
      return String(v);
    };

    function form(root: HostNode): ViewModel {
      const fields: FormFieldModel[] = [];
      let sepSeq = 0;
      walk(root.children, (n) => {
        let type = FIELD_TYPES[n.type];
        if (!type) return;
        const p = n.props;
        if (type === "date" && p.type !== "date") type = "datetime";
        const id = type === "separator" || type === "description" ? `${type}-${++sepSeq}` : (str(p.id) ?? `field-${n.uid}`);
        const f: FormFieldModel = { id, title: str(p.title) ?? "", type, required: false, options: [] };
        if (type === "dropdown" || type === "tags") f.options = options(n.children);
        if (type === "checkbox" && str(p.label)) f.placeholder = str(p.label);
        else if (str(p.placeholder)) f.placeholder = str(p.placeholder);
        if (type === "description") f.text = str(p.text) ?? "";
        if (str(p.info)) f.info = str(p.info);
        if (str(p.error)) f.error = str(p.error);
        if (p.autoFocus) f.autoFocus = true;
        if (type === "file") {
          f.multiple = p.allowMultipleSelection !== false;
          f.directories = !!p.canChooseDirectories;
        }
        const controlled = encode(type, p.value);
        if (controlled !== undefined) f.value = controlled;
        const stored = p.storeValue ? ctx.storedValue(id) : undefined;
        const def = encode(type, p.defaultValue) ?? stored;
        if (def !== undefined) f.default = def;
        if (type !== "separator" && type !== "description") {
          fieldTypes[id] = type;
          const onChange = fnOf(p.onChange);
          const ft = type;
          if (onChange || p.storeValue)
            f.changeHandler = ctx.register(n.uid, "onChange", (v: FormValue) => {
              if (p.storeValue) ctx.storeValue(id, v);
              return onChange?.(ctx.decodeValue(ft, v));
            });
          const onBlur = fnOf(p.onBlur);
          if (onBlur) f.blurHandler = ctx.register(n.uid, "onBlur", (v: FormValue) => onBlur({ type: "blur", target: { id, value: ctx.decodeValue(ft, v) } }));
        }
        fields.push(f);
        return true;
      });
      const actions = actionsOf(root.slots.actions);
      const v: ViewModel = { type: "form", fields, submitTitle: actions[0]?.title ?? "Submit", isLoading: !!root.props.isLoading, actions };
      if (str(root.props.navigationTitle)) v.title = str(root.props.navigationTitle);
      return v;
    }

    const root = hosts(nodes)[0];
    let view: ViewModel | null = null;
    if (root) {
      if (root.type === "List") view = list(root);
      else if (root.type === "Grid") view = grid(root);
      else if (root.type === "Detail") view = detail(root);
      else if (root.type === "Form") view = form(root);
      else if (root.type === "MenuBarExtra") throw new Error("Menu bar commands (MenuBarExtra) are not supported in Glide yet");
      else throw new Error(`A command must render List, Grid, Detail or Form at the top level (got ${root.type})`);
    }
    void actionSeq;
    return { view, fieldTypes };
  }

  return { serialize, toIconSource, colorOf, shortcutDisplay, relativeDate, ICON_GLYPHS, COLORS };
}
