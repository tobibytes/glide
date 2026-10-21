/** Minimal SemVer 2.0 parsing and precedence (no ranges). Accepts an optional leading "v". */
export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: Array<string | number>;
}

const RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseSemver(input: string): SemVer | null {
  const m = RE.exec(input.trim());
  if (!m) return null;
  const prerelease = m[4] ? m[4].split(".").map((id) => (/^\d+$/.test(id) ? Number(id) : id)) : [];
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), prerelease };
}

/** -1 if a < b, 0 if equal precedence, 1 if a > b. Unparseable versions sort below everything. */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return pa === pb ? 0 : pa ? 1 : -1;
  for (const k of ["major", "minor", "patch"] as const) {
    if (pa[k] !== pb[k]) return pa[k] < pb[k] ? -1 : 1;
  }
  // A version without a prerelease has higher precedence than one with.
  if (!pa.prerelease.length || !pb.prerelease.length) {
    if (pa.prerelease.length === pb.prerelease.length) return 0;
    return pa.prerelease.length ? -1 : 1;
  }
  const n = Math.max(pa.prerelease.length, pb.prerelease.length);
  for (let i = 0; i < n; i++) {
    const x = pa.prerelease[i];
    const y = pb.prerelease[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x < y ? -1 : 1;
    if (typeof x === "number") return -1; // numeric identifiers sort before alphanumeric
    if (typeof y === "number") return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

export const isNewer = (candidate: string, current: string): boolean => compareSemver(candidate, current) > 0;

/** "v1.2.3" -> "1.2.3" (only when it parses). */
export function normaliseVersion(tag: string): string | null {
  return parseSemver(tag) ? tag.trim().replace(/^v/, "") : null;
}
