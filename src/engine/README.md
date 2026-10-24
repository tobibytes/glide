# Glide search engine

Pure TypeScript root-search ranking. No Node/Electron APIs; runs in main, tests, or the renderer.
The native app has a Swift port with the same behaviour in `macos/Sources/GlideCore/Engine/`.

Public contract: `api.ts` (`createEngine`, `SearchEngine`). The only change to the contract is the
additive optional `recordUsage(itemId, searchTerm?)` parameter.

## How ranking works

A query is matched against every item with a fuzzy subsequence scorer, the matches are ordered by a
tiered comparator that mixes match quality with frecency (how often and how recently you opened an
item), and the ordered results are split into sections.

### Fuzzy subsequence scoring (`fuzzy.ts`)

| Function | Rule |
|---|---|
| `fuzzyMatch` | ordered-subsequence DP: 4 for the first text char, 3 at a word boundary, 2 elsewhere, 1 when a query separator matches a different text separator; any gap costs 1, consecutive matches are free; query separators with no counterpart are skipped (`skipped`); dots in the query are literal |
| `prepareText` | lowercase + diacritic fold; camelCase boundaries `[a-z0-9]→[A-Z]` from the original case; separators (`\t`, space, nbsp, `-./()[]`) act as boundaries |
| `exactOrPrefix` | `exact` on equality, `prefix` when longer and `startsWith` |
| `passesSensitivity` | low: any; medium: `score ≥ 1.5·(len−skipped−2)+4`; high: `score > 2·(len−skipped)` |
| `wholeWordFloor`, `containsWholeWord`, `wholeWordApplies` | query ≥3 chars, no whitespace, found as a whole word ⇒ title score floored at `4+(len−1)·2+0.5` |

Example: `"vsc"` against `"Visual Studio Code"` scores 4 + 3 + 3 − 2 gaps = 8.

### Frecency (`frecency.ts`)

Each item stores a "future date" instead of a score. Every launch adds 100 to the decayed score,
which then halves every half-life (10 days by default). A never-opened item has score 1.

| Function | Rule |
|---|---|
| `decode` / `visit` | `max(1, 2^((date−now)/halfLife))`; visit: `now + halfLife·log2(max(1, decoded(max(old,now))) + 100)` |
| `decayScore`, `FrecencyCache` | cached `max(1, score·2^(−Δms/halfLifeMs))` |
| search terms | last 3 distinct folded terms per item, newest first; eligible only while frecency > 1 and opened within 17 days; `exact` / `prefix` / `overbounds` (1..3 extra chars) |

### Ordering (`rank.ts`)

| Function | Rule |
|---|---|
| `evaluate` | per-candidate record: alias, titleMatch, title/subtitle DP, synthesized `"title subtitle"`/`"subtitle title"` keywords; keywords gate eligibility only |
| `compareRanked` | tiers T1 alias exact → T2 stored-term exact (when the list has both an exact title and an exact term) → T5 exact title → T6 stored-term exact → T7 subtitle exact → T8 alias prefix → T9/T10 stored-term prefix/overbounds → T11 `max(title, subtitle)` → T12 frecency → T13 title score → T14 kind priority → T15 sortHeuristic → T16 title collation (T3 and T4 are unused) |
| `compareB4` | empty-query order: frecency desc → has alias → kind priority → sortHeuristic → title collation |
| `computeFlags` | `hasExactTitle` only tracked for queries ≥3 chars |

Kind priorities: app 5, workflow 5, system 4, command 4, quicklink 3, snippet 3, setting 1, file 1,
calculator 0, fallback −1.

### Sections (`sections.ts`, `index.ts`)

| Function | Rule |
|---|---|
| `buildEmptySections` | favorites (uncapped, `Set` insertion order), then suggestions (frecency > 1, not favorite, no hotkey, `compareB4` order, capped at `sectionLimit`), then workflows |
| `buildSearchSections` | calculator → results (mixed kinds, capped at `sectionLimit·2`) → files → fallbacks (each capped at `sectionLimit`); the calculator is hidden when a result title or alias starts with the query |
| `index.ts` | pipeline: precomputed candidates, always-shown dynamic rows appended in `compareB4` order, `trimStart` + NFC query, sensitivity `high` by default |

Hotkeys have no effect on matching or ordering (they only exclude an item from Suggestions).

## GLIDE CHOICE notes (marked `// GLIDE CHOICE:` in code)

1. **Frecency date is recomputed from `UsageRecord`** (`frecency.ts` `frecencyDateFromRecord`): the contract has no
   `frecencyDate`, so `visit()` is folded over `launches` (oldest first, ring of 10). Launches that fell out of the
   ring (`count − launches.length`) are approximated as having happened at the oldest recorded timestamp (an upper
   bound). With an empty ring but `count > 0`, `lastLaunchedAt` is used.
2. **Stored search terms persist as an extra optional `searchTerms` property** on the returned record
   (`UsageRecordWithTerms`). Main persists records verbatim so it survives restarts; the engine ignores it when absent.
3. **Diacritic folding = NFD + strip combining marks + lowercase, per UTF-16 unit** (`foldText`), so match indices map
   1:1 onto the original title.
4. **Alias exact/prefix makes an item eligible** (`rank.ts` `evaluate`), so typing an alias always surfaces its item.
   Ordering tiers are unchanged.
5. **Argument extraction** (`index.ts` `extractArgument`): `"g electron"` → if the text before the first whitespace
   fully identifies an `acceptsArgument` item (alias exact > title exact > title prefix, then frecency), that item is
   pinned first with `argument` = remainder.
6. **Fallbacks** are catalogue items of kind `fallback`, in catalogue order, each with `argument` = the query.
7. **Dynamic items** of kinds other than calculator/file are ranked normally when they match; otherwise they are
   appended in `compareB4` order. Their provider score only feeds `sortHeuristic`.
8. **`ScoredItem.score`** is a rank-derived value (strictly decreasing with position). The real order is a
   lexicographic tier comparator, not a sum, so no single additive score exists. `matchScore` is the raw DP score.
9. **Sensitivity** is fixed to `high` (`DEFAULT_SENSITIVITY`) because `EngineOptions` is frozen.
10. **Half-life default is 10 days** (`DEFAULT_HALF_LIFE_DAYS`, `DEFAULT_SETTINGS.frecencyHalfLifeDays`).
11. **Empty-query workflows**: the home view lists the user's workflows after Suggestions, so a fresh install never
    opens to a blank launcher.

## Tests

`pnpm vitest run src/engine` — fuzzy scoring, frecency encoding and search-term memory, ranking tiers, sections and
argument extraction, and a performance guard (2,000 items × 50 queries, soft target < 5 ms, hard fail at 20 ms).
