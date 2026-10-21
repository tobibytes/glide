/**
 * Adds the quicklinks and snippets feature modules to the host's module list. Imported once from
 * src/main/index.ts; additive so src/main/features/registry.ts stays untouched.
 */
import { FEATURES } from "../features/registry";
import { snippetsFeature } from "../snippets/feature";
import { quicklinksFeature } from "./feature";

for (const m of [quicklinksFeature, snippetsFeature]) if (!FEATURES.some((f) => f.id === m.id)) FEATURES.push(m);
