import type { CrawlConfig } from "./crawler";
import type { IndexMeta } from "./files-io";

export type WorkerRequest =
  | { id: number; type: "crawl"; config: CrawlConfig; dir: string; configKey: string }
  | { id: number; type: "compact"; dir: string }
  | { id: number; type: "stop" };

export type WorkerResponse =
  | { id: number; type: "progress"; entries: number }
  | { id: number; type: "done"; bytes: Uint8Array | null; meta: IndexMeta | null }
  | { id: number; type: "error"; message: string };
