# Phase 3 — Gap-Closer Plan (spec conformance)

Date: 2026-11-08. Closes the gaps from the Phase 3 requirements review (`docs/phase3-plan.md` shipped A–D; this finishes the roadmap Part B Phase 3 + Studio UI spec E.3 #5). Four small chunks, each with its own tests. The editor-logic-stays-pure-in-`shared` strategy from the Phase 3 plan continues.

## Gaps being closed
1. **Canvas guides** — no Instagram safe-zone / 4:5 crop / 9:16 reel-overlay guides anywhere.
2. **Entry points** — `EntryPicker` offers only Blank + Template; the spec's **AI-assisted (brief→auto-layout)** and **Fully-AI (run agent→open result)** entries are missing.
3. **Page strip** — select/add/delete only; **no reorder or duplicate**. Plus **multi-select is visual only** (ops use `selectedIds[0]`).
4. **Migration + verification** — `prompt_vars` not converted in the v1→v2 backfill; `inspect.mjs --app` not run on Studio; the "two reconciled renderers vs. one `buildPage`" divergence is unrecorded.

---

## Chunk 1 — Canvas guides (safe-zone / crop / reel overlay)

**Files:** `shared/src/scene/safe-zones.ts` (new, pure), `client/src/routes/StudioScreen.tsx` (overlay layer + toggle), reuse `reelSafe` values (currently only in `server/src/instagram-rules.ts:32`).

**Work:**
1. Add shared safe-zone constants + a pure `safeZones(format, size) → { crop?: Rect; unsafe: Rect[] }`:
   - feed/carousel (4:5): a centered crop guide + the IG action-rail margin.
   - reel (9:16): the 9:16 interface overlay — top `14%`, bottom `35%` (caption/audio), right `10%` (action rail), side `6%` — mirrored from `reelSafe` (move the constant into `shared/src/scene` so client and server share one source).
2. Render the zones as a **non-interactive** Konva overlay layer (dashed rects, muted), behind a "Guides" toggle; off by default for export/render.

**Unit tests** (`shared` pure, in `server/src/__tests__/safe-zones.test.ts`):
- `safeZones('reel', {w:1080,h:1920})` returns unsafe rects matching the percentages (top 268.8px, bottom 672px, right 108px, side 64.8px).
- `safeZones('feed', …)` returns a 4:5 crop guide inside bounds; no reel action-rail rect.
- All returned rects are within the canvas bounds for every format.

## Chunk 2 — The two missing entry points

**Files:** `client/src/routes/StudioScreen.tsx` (`EntryPicker`), `client/src/api.ts` (create+run helper if absent), `shared/src/scene` (reuse `autoLayout` via `runAutoLayout`).

**Work:**
1. **AI-assisted**: a brief textarea → `runAutoLayout({ brief, tokens, format })` → open the editor on the resulting `SceneDoc` (self-contained; `autoLayout` already exists and is tested).
2. **Fully-AI**: create a post + trigger the agent run, then open the editor on the produced scene when the run completes. Note the dependency — this should enqueue an `agent_run` job once **Phase 2 Chunk 1** lands; until then it calls the existing inline path. Show a "generating…" state and open on completion via the run/SSE.
3. `EntryPicker` now shows four choices: Blank · Template · From a brief (AI-assisted) · Fully AI.

**Unit tests:**
- Pure: `runAutoLayout` from a brief returns a schema-valid `SceneDoc` with a hook layer + background in `token:` colors (extends existing `layout` coverage with the studio-action wrapper).
- Client smoke (`StudioScreen.test.tsx`): the entry picker renders all four options; choosing "From a brief" with text calls the auto-layout path and transitions out of the entry view.

## Chunk 3 — Page reorder/duplicate + real multi-select

**Files:** `shared/src/scene/editor.ts` (pure page ops), `client/src/routes/StudioScreen.tsx` (page strip DnD + duplicate button; multi-select ops).

**Work:**
1. Pure helpers in `editor.ts`: `reorderPages(pages, fromIndex, toIndex)` and `duplicatePage(page)` (fresh page id + fresh layer ids via the existing `duplicateLayer`).
2. Page strip: drag-to-reorder and a duplicate control (respect the ≤10 carousel cap).
3. Make `duplicateSelected`/`copySelected`/`deleteSelected`/reorder operate over **all** `selectedIds`, not just `[0]`.

**Unit tests** (`shared`, `scene-editor.test.ts` additions):
- `reorderPages` moves a page and is a no-op for out-of-range / same index.
- `duplicatePage` returns a page with a new id and all layers re-ided (no shared ids with the source), content otherwise equal.
- Multi-duplicate: duplicating a 3-id selection yields 3 new layers, all with fresh ids and offset positions.

## Chunk 4 — `prompt_vars` migration + verification + sign-off

**Files:** `shared/src/scene/index.ts` (`upgradePostToScene`), `server/src/scene/backfill.ts` (pass `prompt_vars`), `DESIGN.md` (renderer note).

**Work:**
1. Extend `upgradePostToScene` with a `prompt_vars` fallback: when a post has no `canvas_json` and no `post_slides`, seed the scene from `prompt_vars` (hook/on-image text → a hook text layer; carousel slide plates → pages). Backfill selects and passes `prompt_vars`.
2. Run `inspect.mjs --app` against the Studio at 1440/768/390 and fix to 0 FAIL; record the result in the tracker.
3. Record the deliberate divergence in `DESIGN.md`: the server renders via Canvas-2D `renderer.ts` and the client via react-konva, reconciled by the gated golden test rather than a single `buildPage` — with the rationale.

**Unit tests** (`scene-backfill.test.ts` addition):
- A post with only `prompt_vars` (null `canvas_json`, no slides) backfills to a schema-valid `SceneDoc` containing the hook text; a carousel `prompt_vars` yields the expected page count.

---

## Order & exit
| Chunk | Depends on | Effort |
|---|---|---|
| 1 — guides | — | ~2.5h |
| 2 — entry points | Phase 2 Ch.1 for fully-AI (AI-assisted is standalone) | ~3h |
| 3 — page/multi-select | — | ~3h |
| 4 — migration + verify | — | ~2h |

1, 3, 4 are independent; 2's fully-AI path is best after Phase 2 Chunk 1 (job enqueue) but AI-assisted ships now.

**Exit:** `pnpm typecheck` + `pnpm test` (server+client) green; Studio shows guides (toggle), all four entry points, page reorder/duplicate, and multi-select ops; `prompt_vars`-only posts backfill; Studio passes `inspect.mjs --app` 0 FAIL at 1440/768/390; the renderer divergence is recorded in `DESIGN.md`.
