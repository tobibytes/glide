/** automations.json in the feature's data dir: atomic writes, tolerant reads (bad entries are dropped). */
import fs from "node:fs";
import path from "node:path";
import { validateAutomation, type Automation } from "./model";

export const FILE_NAME = "automations.json";
const VERSION = 1;

export function loadAutomations(dir: string, now = Date.now()): Automation[] {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, FILE_NAME), "utf8")) as { automations?: unknown };
    if (!Array.isArray(raw.automations)) return [];
    const seen = new Set<string>();
    const out: Automation[] = [];
    for (const entry of raw.automations) {
      const res = validateAutomation(entry, now);
      if (res.ok && !seen.has(res.automation.id)) {
        seen.add(res.automation.id);
        out.push(res.automation);
      }
    }
    return out;
  } catch {
    return [];
  }
}

export function saveAutomations(dir: string, list: Automation[]): void {
  const file = path.join(dir, FILE_NAME);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify({ version: VERSION, automations: list }, null, 1));
  fs.renameSync(`${file}.tmp`, file);
}

/** Coalesce bursts of saves (a run writes the log twice) into one write per `delayMs`. */
export function debouncedSaver(save: (list: Automation[]) => void, delayMs = 300) {
  let timer: NodeJS.Timeout | undefined;
  let pending: Automation[] | undefined;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (pending) {
      const list = pending;
      pending = undefined;
      save(list);
    }
  };
  return {
    schedule(list: Automation[]) {
      pending = list;
      if (!timer) timer = setTimeout(flush, delayMs);
    },
    flush,
  };
}
