import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { DEFAULT_SETTINGS, type Quicklink, type Settings, type Snippet, type UsageRecord, type UserData, type Workflow } from "@shared/types";
import { seedQuicklinks, seedSnippets, seedWorkflows } from "./seed";

const SAVE_DEBOUNCE_MS = 250;

export interface StoreEvents {
  change: [UserData];
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as unknown;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await fs.rename(tmp, file);
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const strMap = (v: unknown): Record<string, string> => {
  if (!isRecord(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) if (typeof val === "string") out[k] = val;
  return out;
};

function normaliseData(raw: unknown, now: number): { data: UserData; fresh: boolean } {
  if (!isRecord(raw)) {
    return {
      fresh: true,
      data: {
        settings: { ...DEFAULT_SETTINGS },
        workflows: seedWorkflows(now),
        quicklinks: seedQuicklinks(),
        snippets: seedSnippets(),
        favorites: [],
        aliases: {},
        hotkeys: {},
      },
    };
  }
  const settings: Settings = { ...DEFAULT_SETTINGS, ...(isRecord(raw.settings) ? (raw.settings as Partial<Settings>) : {}) };
  return {
    fresh: false,
    data: {
      settings,
      workflows: arr<Workflow>(raw.workflows),
      quicklinks: arr<Quicklink>(raw.quicklinks),
      snippets: arr<Snippet>(raw.snippets),
      favorites: arr<string>(raw.favorites).filter((f) => typeof f === "string"),
      aliases: strMap(raw.aliases),
      hotkeys: strMap(raw.hotkeys),
    },
  };
}

export class Store extends EventEmitter<StoreEvents> {
  private data: UserData;
  private usage: UsageRecord[] = [];
  private readonly dataPath: string;
  private readonly usagePath: string;
  private dataTimer: NodeJS.Timeout | undefined;
  private usageTimer: NodeJS.Timeout | undefined;
  private pendingWrites = Promise.resolve();

  constructor(private readonly dir: string) {
    super();
    this.dataPath = path.join(dir, "data.json");
    this.usagePath = path.join(dir, "usage.json");
    this.data = normaliseData(undefined, Date.now()).data;
  }

  async load(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const { data, fresh } = normaliseData(await readJson(this.dataPath), Date.now());
    this.data = data;
    const usageRaw = await readJson(this.usagePath);
    this.usage = arr<UsageRecord>(usageRaw).filter((u) => isRecord(u) && typeof u.itemId === "string");
    if (fresh) await writeJsonAtomic(this.dataPath, this.data);
  }

  getData(): UserData {
    return this.data;
  }

  getSettings(): Settings {
    return this.data.settings;
  }

  getUsage(): UsageRecord[] {
    return this.usage;
  }

  setUsage(records: UsageRecord[]): void {
    this.usage = records;
    if (this.usageTimer) clearTimeout(this.usageTimer);
    this.usageTimer = setTimeout(() => void this.persist(this.usagePath, this.usage), SAVE_DEBOUNCE_MS);
  }

  /** Apply a mutation, schedule a debounced atomic write and notify listeners. */
  mutate(fn: (data: UserData) => void): UserData {
    fn(this.data);
    if (this.dataTimer) clearTimeout(this.dataTimer);
    this.dataTimer = setTimeout(() => void this.persist(this.dataPath, this.data), SAVE_DEBOUNCE_MS);
    this.emit("change", this.data);
    return this.data;
  }

  setSettings(patch: Partial<Settings>): Settings {
    const clean: Partial<Settings> = {};
    for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof Settings>) {
      const value = patch[key];
      if (value !== undefined && typeof value === typeof DEFAULT_SETTINGS[key]) {
        (clean as Record<string, unknown>)[key] = value;
      }
    }
    return this.mutate((d) => {
      d.settings = { ...d.settings, ...clean };
    }).settings;
  }

  saveWorkflow(wf: Workflow): Workflow {
    const saved: Workflow = { ...wf, updatedAt: Date.now(), createdAt: wf.createdAt || Date.now() };
    this.mutate((d) => {
      const i = d.workflows.findIndex((w) => w.id === wf.id);
      if (i >= 0) d.workflows[i] = saved;
      else d.workflows.push(saved);
    });
    return saved;
  }

  deleteWorkflow(id: string): void {
    this.mutate((d) => {
      d.workflows = d.workflows.filter((w) => w.id !== id);
    });
  }

  saveQuicklink(q: Quicklink): Quicklink {
    this.mutate((d) => {
      const i = d.quicklinks.findIndex((x) => x.id === q.id);
      if (i >= 0) d.quicklinks[i] = q;
      else d.quicklinks.push(q);
    });
    return q;
  }

  deleteQuicklink(id: string): void {
    this.mutate((d) => {
      d.quicklinks = d.quicklinks.filter((x) => x.id !== id);
    });
  }

  saveSnippet(s: Snippet): Snippet {
    this.mutate((d) => {
      const i = d.snippets.findIndex((x) => x.id === s.id);
      if (i >= 0) d.snippets[i] = s;
      else d.snippets.push(s);
    });
    return s;
  }

  deleteSnippet(id: string): void {
    this.mutate((d) => {
      d.snippets = d.snippets.filter((x) => x.id !== id);
    });
  }

  toggleFavorite(itemId: string): string[] {
    return this.mutate((d) => {
      d.favorites = d.favorites.includes(itemId) ? d.favorites.filter((f) => f !== itemId) : [...d.favorites, itemId];
    }).favorites;
  }

  setAlias(itemId: string, alias: string | null): Record<string, string> {
    return this.mutate((d) => {
      if (alias && alias.trim()) d.aliases[itemId] = alias.trim();
      else delete d.aliases[itemId];
    }).aliases;
  }

  setHotkey(itemId: string, accel: string | null): Record<string, string> {
    return this.mutate((d) => {
      if (accel && accel.trim()) d.hotkeys[itemId] = accel.trim();
      else delete d.hotkeys[itemId];
    }).hotkeys;
  }

  /** Write anything still pending (called before quit). */
  async flush(): Promise<void> {
    if (this.dataTimer) {
      clearTimeout(this.dataTimer);
      this.dataTimer = undefined;
      await this.persist(this.dataPath, this.data);
    }
    if (this.usageTimer) {
      clearTimeout(this.usageTimer);
      this.usageTimer = undefined;
      await this.persist(this.usagePath, this.usage);
    }
    await this.pendingWrites;
  }

  // Writes are serialised so a flush never races a debounced save on the same file.
  private persist(file: string, value: unknown): Promise<void> {
    this.pendingWrites = this.pendingWrites
      .then(() => writeJsonAtomic(file, value))
      .catch((err: unknown) => console.error(`[store] failed to write ${file}:`, err));
    return this.pendingWrites;
  }
}
