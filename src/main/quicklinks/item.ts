/** Search-item fields for a quicklink row (pure): which arguments the launcher should ask for. */
import type { Quicklink, SearchItem } from "@shared/types";
import { quicklinkArguments } from "./core";

export function quicklinkItemExtras(q: Quicklink): Pick<SearchItem, "acceptsArgument" | "data"> {
  const args = quicklinkArguments(q.url);
  if (!args.length) return { acceptsArgument: false, ...(q.openWith ? { data: { openWith: q.openWith } } : {}) };
  // Plain objects only: data must stay JSON-serialisable across IPC.
  return { acceptsArgument: true, data: { arguments: args.map((a) => ({ ...a })), ...(q.openWith ? { openWith: q.openWith } : {}) } };
}
