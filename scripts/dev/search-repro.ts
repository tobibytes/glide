// Runs the real app scanner + engine outside Electron and times each query.
import { createEngine } from "@engine/index";
import { createAppSource } from "../../src/main/sources/apps";
import { calculatorItems } from "../../src/main/sources/calculator";
import { DEFAULT_SETTINGS } from "@shared/types";

const apps = createAppSource(() => DEFAULT_SETTINGS.appDirectories);
await apps.rescan();
const items = apps.items();
console.log("apps:", items.length);
const engine = createEngine({ frecencyHalfLifeDays: 10, sectionLimit: 8 });
engine.setItems(items);
for (const q of ["", "s", "sa", "saf", "safari", "vsc", "12*(3+4)", "set", "zzqxj"]) {
  const t = performance.now();
  const res = engine.search(q, { dynamicItems: calculatorItems(q) });
  const ms = (performance.now() - t).toFixed(2);
  console.log(JSON.stringify(q), ms + "ms", res.sections.map((s) => `${s.id}:${s.items.slice(0, 3).map((i) => i.item.title).join("|")}`).join("  "));
}
apps.dispose();
