# Glide search engine

Pure TypeScript port of the root-search ranking reverse-engineered from Raycast 2.8.2
(`research/01-backend-ranking.md`). No Node/Electron APIs; runs in main, tests, or the renderer.

Public contract: `api.ts` (`createEngine`, `SearchEngine`). The only change to the contract is the
additive optional `recordUsage(itemId, searchTerm?)` parameter.

## Modules → report sections

| File | Rule | Report |
|---|---|---|
| `fuzzy.ts` `fuzzyMatch` | ordered-subsequence DP: 4 start-of-text, 3 word boundary, 2 elsewhere, 1 separator→separator, gap −1, consecutive free, skippable query separators (`skipped`), literal dots (`V4`) | §2 (`af`, `X7e`, `sf`), §1.5 |
| `fuzzy.ts` `prepareText` | lowercase + fold; camelCase boundaries `[a-z0-9]→[A-Z]` from the original case; separators act as boundaries | §2 (`nf`, `K7e`) |
| `fuzzy.ts` `exactOrPrefix` | `exact` on equality, `prefix` when longer and `startsWith` | §1.5 (`J7e`) |
| `fuzzy.ts` `passesSensitivity` | low: any; medium: `score ≥ 1.5·(len−skipped−2)+4`; high: `score > 2·(len−skipped)` | §1.5 (`rf`) |
| `fuzzy.ts` `wholeWordFloor`, `containsWholeWord`, `wholeWordApplies` | query ≥3 chars, no whitespace, found as a whole word ⇒ title score floored at `4+(len−1)·2+0.5` | §1.5 (`$Yi`/`eXi`, `q7e`) |
| `frecency.ts` `decode` / `visit` | `max(1, 2^((date−now)/halfLife))`; visit: `now + halfLife·log2(max(1, decoded(max(old,now))) + 100)` | §1.4 (0x50ac18, 0x49d644) |
| `frecency.ts` `decayScore`, `FrecencyCache` | JS-side cache `max(1, score·2^(−Δms/halfLifeMs))` | §1.3 (`PJi`) |
| `frecency.ts` search terms | last 3 distinct folded terms per item, newest first; eligible only while frecency > 1 and opened within 17 days; `exact` / `prefix` / `overbounds` (1..3 extra chars) | §1.2 (`EYi`), §1.5 (`YYi`, `Y7e`, `fXi`, `pXi`, `mXi`) |
| `rank.ts` `evaluate` | per-candidate record: alias, titleMatch, title/subtitle DP, synthesized `"title subtitle"`/`"subtitle title"` keywords, keywords gate eligibility only | §1.5 (`iXi`), §4 |
| `rank.ts` `compareRanked` | tiers T1 alias exact → T2 stored-term exact (when list has both exact title and exact term) → T5 exact title → T6 stored-term exact → T7 subtitle exact → T8 alias prefix → T9/T10 stored-term prefix/overbounds → T11 `max(title, subtitle)` → T12 frecency → T13 title score → T14 kind priority → T15 sortHeuristic → T16 title collation | §1.6 (`sXi`, `of`) |
| `rank.ts` `compareB4` | frecency desc → has alias → kind priority → sortHeuristic → title collation | §1.6 (`B4`) |
| `rank.ts` `computeFlags` | `hasExactTitle` only tracked for queries ≥3 chars | §1.7 |
| `sections.ts` `buildEmptySections` | favorites, then suggestions (frecency > 1, not favorite, no hotkey, B4 order) | §1.7 (`VXi`, `PXi`, `MXi`) |
| `sections.ts` `buildSearchSections` | calculator → results → files → fallbacks; calculator suppressed when a result title/alias starts with the query | §1.7 (`HXi`, `_Xi`) |
| `index.ts` | pipeline: precomputed candidates, `matching: 'always'` dynamic rows appended in B4 order, `trimStart` + NFC query, sensitivity `high` default | §1.7 (`cXi`), §1.5 |

Hotkeys have no effect on matching or ordering (only exclusion from Suggestions), per §4.

## GLIDE CHOICE deviations (marked `// GLIDE CHOICE:` in code)

1. **Frecency date is recomputed from `UsageRecord`** (`frecency.ts` `frecencyDateFromRecord`): the contract has no
   `frecencyDate`, so `visit()` is folded over `launches` (oldest first, ring of 10). Launches that fell out of the
   ring (`count − launches.length`) are approximated as having happened at the oldest recorded timestamp (an upper
   bound). With an empty ring but `count > 0`, `lastLaunchedAt` is used.
2. **Stored search terms persist as an extra optional `searchTerms` property** on the returned record
   (`UsageRecordWithTerms`). Main persists records verbatim so it survives restarts; the engine ignores it when absent.
3. **Diacritic folding = NFD + strip combining marks + lowercase, per UTF-16 unit** (`foldText`), so match indices map 1:1
   onto the original title. Raycast uses a bundled `transliterate()` (behaviour marked INFERRED in the report).
4. **Alias exact/prefix makes an item eligible** (`rank.ts` `evaluate`). Raycast's `isMatching` ignores the alias
   because its frontend reacts to alias typing; Glide has no such path. Ordering tiers are unchanged.
5. **Kind priorities**: app 5, workflow 5, system 4, quicklink 3, snippet 3, setting 1, file 1, calculator 0,
   fallback −1 (Raycast: application 5, command 4, menu-bar/quicklink 3, preference/file 1).
6. **Omitted tiers**: T3 (boosted built-in terms `dXi`) and T4 (contact demotion) have no Glide equivalent.
7. **Argument extraction** (`index.ts` `extractArgument`): `"g electron"` → if the text before the first whitespace
   fully identifies an `acceptsArgument` item (alias exact > title exact > title prefix, then frecency), that item is
   pinned first with `argument` = remainder. Raycast does this in the frontend.
8. **Sections**: one mixed `results` section capped at `sectionLimit·2`; `files` and `fallbacks` capped at
   `sectionLimit`; `favorites` uncapped in `Set` insertion order (Raycast uses `favoriteOrder`); `suggestions`
   honours `sectionLimit` (Raycast caps at 5) and skips the "just installed" / `suggestionPriority` fills.
   `fallbacks` are catalogue items of kind `fallback`, in catalogue order, each with `argument` = the query.
9. **Dynamic items** of kinds other than calculator/file are ranked normally when they match; otherwise they are
   appended in B4 order (Raycast's `matching: 'always'` rows). Their provider score only feeds `sortHeuristic`.
10. **`ScoredItem.score`** is a rank-derived value (strictly decreasing with position). The real order is a
    lexicographic tier comparator, not a sum, so no single additive score exists. `matchScore` is the raw DP score.
11. **Sensitivity** is fixed to Raycast's default `high` (`DEFAULT_SENSITIVITY`) because `EngineOptions` is frozen.
12. **Half-life default is 10 days** (Raycast, and `DEFAULT_SETTINGS.frecencyHalfLifeDays`) even though the `api.ts`
    doc comment says 7.
13. `JYi` (leading `/` in the query turns the first `/` of a title into a space) and bundle-id matching on queries
    containing `.` are not ported (no equivalent item fields).

## Tests

`pnpm vitest run src/engine` — fuzzy scoring, frecency encoding and search-term memory, ranking tiers, sections and
argument extraction, and a performance guard (2,000 items × 50 queries, soft target < 5 ms, hard fail at 20 ms).
