// PASS/FAIL collector shared by the suites.
export function createReporter(name) {
  const results = [];
  const t0 = Date.now();
  return {
    results,
    check(title, ok, detail = "") {
      results.push({ title, ok: !!ok, detail: typeof detail === "string" ? detail : JSON.stringify(detail) });
      return !!ok;
    },
    /** Recorded and printed, never fails the suite (known issues, degraded environments). */
    warn(title, detail = "") {
      results.push({ title, ok: true, warn: true, detail: typeof detail === "string" ? detail : JSON.stringify(detail) });
    },
    /** Run `fn`; an exception becomes a FAIL instead of aborting the suite. */
    async step(title, fn) {
      try {
        const r = await fn();
        if (r !== undefined && typeof r === "object" && "ok" in r) results.push({ title, ok: !!r.ok, detail: r.detail ?? "" });
      } catch (err) {
        results.push({ title, ok: false, detail: String(err?.message ?? err) });
      }
    },
    summary() {
      for (const r of results) console.log(`${r.warn ? "WARN" : r.ok ? "PASS" : "FAIL"}  ${r.title}${r.detail ? `  — ${r.detail.slice(0, 400)}` : ""}`);
      const failed = results.filter((r) => !r.ok).length;
      console.log(`\n[${name}] ${results.length - failed}/${results.length} passed in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      return failed;
    },
  };
}
