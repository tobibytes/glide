/** layouts.json in the feature's data dir; written atomically. */
import fs from "node:fs";
import path from "node:path";
import { EMPTY_FILE, parseFile, serializeFile, type Layout, type LayoutsFile, type Workspace } from "./model";

export class LayoutStore {
  private data: LayoutsFile;
  private readonly file: string;

  constructor(dir: string) {
    this.file = path.join(dir, "layouts.json");
    let raw: string | null = null;
    try {
      raw = fs.readFileSync(this.file, "utf8");
    } catch {
      raw = null;
    }
    this.data = raw ? parseFile(raw) : { ...EMPTY_FILE, layouts: [], workspaces: [] };
  }

  get layouts(): Layout[] {
    return this.data.layouts;
  }

  get workspaces(): Workspace[] {
    return this.data.workspaces;
  }

  layout(id: string): Layout | undefined {
    return this.data.layouts.find((l) => l.id === id);
  }

  workspace(id: string): Workspace | undefined {
    return this.data.workspaces.find((w) => w.id === id);
  }

  putLayout(layout: Layout): void {
    const i = this.data.layouts.findIndex((l) => l.id === layout.id);
    if (i >= 0) this.data.layouts[i] = layout;
    else this.data.layouts.push(layout);
    this.flush();
  }

  deleteLayout(id: string): void {
    this.data.layouts = this.data.layouts.filter((l) => l.id !== id);
    this.data.workspaces = this.data.workspaces.map((w) => (w.layoutId === id ? { ...w, layoutId: null } : w));
    this.flush();
  }

  putWorkspace(ws: Workspace): void {
    const i = this.data.workspaces.findIndex((w) => w.id === ws.id);
    if (i >= 0) this.data.workspaces[i] = ws;
    else this.data.workspaces.push(ws);
    this.flush();
  }

  deleteWorkspace(id: string): void {
    this.data.workspaces = this.data.workspaces.filter((w) => w.id !== id);
    this.flush();
  }

  private flush(): void {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, serializeFile(this.data));
    fs.renameSync(tmp, this.file);
  }
}
