import fs from "node:fs";
import path from "node:path";
import { environment } from "@raycast/api";

/** Appends a line to <supportPath>/<file> so tests can see what ran. */
export function record(file: string, line: string) {
  fs.mkdirSync(environment.supportPath, { recursive: true });
  fs.appendFileSync(path.join(environment.supportPath, file), `${line}\n`);
}
