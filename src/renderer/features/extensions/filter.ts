/** Local filtering for extension lists that did not subscribe to onSearchTextChange. */
import type { ListItemModel } from "../../../extension-api/types";

const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

function score(item: ListItemModel, words: string[]): number {
  const title = norm(item.title);
  const rest = norm([item.subtitle ?? "", ...item.keywords, ...item.accessories.map((a) => a.text ?? a.tag ?? "")].join(" "));
  let total = 0;
  for (const w of words) {
    if (title.startsWith(w)) total += 100;
    else if (new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(title)) total += 60;
    else if (title.includes(w)) total += 30;
    else if (rest.includes(w)) total += 10;
    else return 0;
  }
  // Shorter titles win ties ("York" before "New York" for "york").
  return total - Math.min(title.length, 50) / 100;
}

export function filterItems(items: ListItemModel[], query: string): ListItemModel[] {
  const words = norm(query).trim().split(/\s+/).filter(Boolean);
  if (!words.length) return items;
  return items
    .map((item, i) => ({ item, i, s: score(item, words) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.item);
}
