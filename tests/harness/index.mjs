// Public surface of the Glide quality harness. See docs/TESTING.md.
export { launchGlide, withGlide, GlideApp, ROOT, testTmpRoot, processTreeRss, descendants, snapshotApp } from "./app.mjs";
export { Page, sleep, STABLE_CSS } from "./page.mjs";
export { connectCdp, listTargets } from "./cdp.mjs";
export { allocatePort, releasePort, PORT_RANGE } from "./ports.mjs";
export { seedDataDir, syntheticQuicklinks, perfQueries, rng } from "./fixtures.mjs";
export { decodePng, encodePng, diffImages, downscale, maskRects } from "./png.mjs";
export { parseKey, MOD } from "./keys.mjs";
export { createReporter } from "./report.mjs";
