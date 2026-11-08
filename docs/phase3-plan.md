# Phase 3 — Creative Studio (Konva): Detailed Implementation Plan

Audit date: 2026-11-07. Based on a full read of the Phase 3 source files. Work is divided into **4 chunks**, each shippable on its own and each with its own unit tests.

---

## What already exists (do not rebuild)

| File | What it does | State |
|---|---|---|
| `shared/src/scene/index.ts` (255 LoC) | Scene schema: `BrandTokens`, `resolveToken`, `SceneBackground` (color/gradient/image), 4 layer types (`text`/`image`/`shape`/`group`), `ScenePage`, `SceneTimeline`, `SceneDoc`, `SCENE_SIZES`/`SCENE_ASPECTS`, `newPageId`/`newLayerId`, `defaultSceneDoc`, `upgradeCanvasDoc` (v1→v2), `parseSceneJson` | **Plain TS types, not zod.** Complete enough to build on. |
| `shared/src/scene/renderer.ts` (332 LoC) | Shared Canvas-2D renderer behind a `Ctx2D`/`LoadImageFn` abstraction: `renderPage`, background fill, text layer with word-wrap + `measureText`, shape layer with scrim gradient, image layer with crop, group layer | Runs in both browser and server. |
| `server/src/render/scene-render.ts` | `@napi-rs/canvas` server renderer: `renderScenePage`, `renderSceneAllPages`, image cache | The week-1 spike — **done**. |
| `server/src/render/__tests__/scene-render.test.ts` | 10 tests: PNG validity, dimensions, solid color, gradient, text region, shape, token colors, reel dims, perf | Passing. |
| `client/src/routes/StudioScreen.tsx` (858 LoC) | Working Konva editor: `Stage`/`Layer`/`Text`/`Rect`/`Ellipse`/`Transformer`, undo/redo history, layers panel (visibility/lock/delete), format switch, `addPage` page strip, an AI "4 variations" button, send-for-review | No `Image` layer, no snapping, no multi-select, no templates, no brand kit, no reel timeline, no feed view. |
| `server/src/http/routes/studio.ts` | `GET`/`PATCH /api/posts/:id/scene`; `GET`/`POST`/`DELETE /api/assets` (with sha256 dedup) | No `/render`. |
| `server/src/db/migrations/005_phase3.sql` | `assets` table (kind/url/w/h/source/provider/prompt/sha256/post_id/brand_id) + `posts.scene_json` column | Schema present; **no data backfill**. |
| `server/src/media/reel-burn.ts` | `whichFfmpeg`, cover-frame extraction | v1 ASS-subtitle path; reusable helpers. |

**Key gaps the 4 chunks close:** no zod validation, no shared `resolve.ts` text-fit module, no DB-level v1→v2 backfill, no `/render` endpoint, no golden client↔server parity test, no scene-based reel compositing, and the editor is missing snapping/multi-select/z-order/copy-paste/templates/brand-kit/uploads/reel-timeline/feed-view/image-layer. No client test harness exists.

**Testing strategy (applies to all chunks):** keep editor logic in **pure functions** in `shared/src/scene/*` (and server modules) so it is tested under the existing server vitest with zero browser. Only Chunk C adds a thin client test harness for the React wiring that cannot be made pure. "Each chunk has its own tests" below means a green `pnpm --filter server test` (plus Chunk C's client tests) at the end of that chunk.

---

## Chunk A — Schema hardening, token/fit resolver, v1→v2 backfill

**Goal:** a validated, single-source-of-truth scene model with a safe upgrade path, so every later chunk can trust its input.

**Files:** `shared/src/scene/schema.ts` (new, zod), `shared/src/scene/resolve.ts` (new), `shared/src/scene/index.ts` (wire in), `server/src/db/migrations/007_scene_backfill.sql` or a `scripts/backfill-scene.ts`, `server/src/http/routes/studio.ts` (validate on PATCH).

**Work:**
1. **zod schema** mirroring the existing TS types (`SceneDocSchema`, layer unions, background union). `parseSceneJson` and `PATCH /scene` validate through it and reject invalid docs with a 400 listing the zod issues. Keep the hand-written types as `z.infer` to avoid drift.
2. **`resolve.ts`** — extract and formalize: `resolveToken(value, tokens)` (move from index.ts), `resolveColor`, and a pure `fitText({ text, maxWidth, maxHeight, fontSize, measure })` that word-wraps and shrink-to-fits using an **injected `measure(text, fontSize)`** (no canvas dependency), returning `{ lines, fontSize }`. The renderer and the editor both call this instead of each re-implementing wrap.
3. **v1→v2 backfill** — a one-shot that converts every post with `canvas_json`/`prompt_vars`/`post_slides` and null `scene_json` into `scene_json` via `upgradeCanvasDoc`. Idempotent (skips rows that already have `scene_json`). Run it from the migration runner or a `pnpm backfill:scene` script.

**Unit tests** (`shared` or `server/src/__tests__/scene-schema.test.ts`, `scene-resolve.test.ts`):
- `SceneDocSchema` **accepts** a `defaultSceneDoc('feed')` and a full carousel+reel doc.
- `SceneDocSchema` **rejects**: unknown layer `type`, missing `size`, a `text` layer with no `text`, an out-of-range `opacity`.
- `upgradeCanvasDoc` maps a v1 `canvas_json` (background + text + image) → a `SceneDoc` with the matching layer types, preserved positions, and `version: 2`; a v1 doc with slides → multiple pages.
- `upgradeCanvasDoc` is **idempotent-safe**: passing a value that is already a `SceneDoc`-shaped object returns a valid SceneDoc (no double-wrap).
- `resolveToken('token:primary', tokens)` → hex; `resolveToken('#fff', tokens)` → unchanged; unknown token → returned verbatim.
- `fitText` wraps at word boundaries (never mid-word), shrinks `fontSize` when text overflows `maxHeight`, and is deterministic given a stub `measure`.
- **DB backfill test** (hermetic temp `DB_PATH`, mirror `brand-context.test.ts`): seed a post with `canvas_json` and null `scene_json`, run the backfill, assert `scene_json` is now a valid SceneDoc and a second run is a no-op.

---

## Chunk B — Server render pipeline: `/render` endpoint, stable hash, golden parity

**Goal:** turn an approved scene into real image assets on the server, deterministically, and prove the server PNG matches the browser.

**Files:** `server/src/render/scene-render.ts` (extend), `server/src/render/hash.ts` (new), `server/src/http/routes/studio.ts` (add `/render`), `client/tests/studio-golden.spec.ts` (new, Playwright), `server/src/render/__tests__/*`.

**Work:**
1. **`POST /api/posts/:id/render`** — loads the post's scene, renders all pages via `renderSceneAllPages`, uploads each PNG (reuse the media/R2 or local store), inserts `assets` rows (`source:'render'`, sha256), and returns `{ pages: [{ url, sha256, w, h }] }`. Carousel → N pages; feed → 1; reel → cover frame (full reel compositing is Chunk D).
2. **Stable content hash** — `sceneHash(doc)` over the resolved, normalized scene (sorted keys, tokens resolved) so an unchanged scene always renders to the same asset and re-render is skipped.
3. **Golden parity** — `client/tests/studio-golden.spec.ts`: render the same `SceneDoc` in a headless browser (the client builder) and compare with the server PNG using `pixelmatch`, requiring <1% differing pixels. Fonts loaded identically on both sides. This is the risk the roadmap flagged; gate it behind a `GOLDEN=1` env so CI without a browser still passes.

**Unit tests** (`server/src/render/__tests__/render-endpoint.test.ts`, `render-hash.test.ts`):
- `renderSceneAllPages` returns one buffer per page for a 3-page carousel; one for feed.
- `sceneHash` is **stable** (same doc twice → same hash) and **sensitive** (changing a layer's text/color changes the hash).
- `POST /:id/render` (hermetic DB + a stubbed image store): inserts the expected number of `assets` rows with `source:'render'`, returns their urls + hashes, and a second call with an unchanged scene reuses the hash (no duplicate asset).
- Extend the pixel-regression tests: an **image layer** renders inside its box; a **scrim** darkens the lower region; a reel renders a 1080×1920 cover.
- Golden parity (`GOLDEN=1`, skipped otherwise): server vs browser PNG <1% diff.

---

## Chunk C — Konva editor: selection, snapping, templates, brand kit, uploads

**Goal:** make the studio a real builder, not a layer list. Keep every non-trivial rule as a **pure function** in `shared/src/scene/editor.ts` so it is testable without the DOM.

**Files:** `shared/src/scene/editor.ts` (new, pure logic), `shared/src/scene/templates.ts` (new), `client/src/routes/StudioScreen.tsx` (wire), `client/src/components/studio/*` (BrandKitPanel, TemplatePicker, UploadPanel, Inspector), plus **a client test harness** (`client/vitest.config.ts` + jsdom + `@testing-library/react`).

**Work:**
1. **Pure editor logic in `editor.ts`:** `snapLayer(layer, others, threshold)` → adjusted x/y + active guide lines; `reorder(layers, id, dir)` (z-order); `duplicateLayer(layer, offset)`; `applyScenePatch(doc, patch)` + history helpers (`pushHistory`/`undo`/`redo` invariants); `offBrandColors(doc, tokens)` → list of layers whose colors aren't token-derived.
2. **`templates.ts`:** 8–12 brand-tokenized `SceneDoc` factories, each `template(format, tokens) → SceneDoc` using `token:` refs only.
3. **Editor wiring:** `Image` layer support in the Konva stage; multi-select + marquee; snapping guides; copy/paste/duplicate; keyboard shortcuts; z-order controls; **brand-kit panel** (swatches/fonts/logo from the brand's visual identity); **uploads + asset library** (wire `GET/POST /api/assets` and the unused `fetchPostMedia`); inspector bound to brand tokens with an **off-brand warning**; a **"from scratch"** entry (blank or template); a **feed view** that drops the scene into the profile-grid preview.

**Unit tests:**
- *Pure (server vitest, `shared/...editor.test.ts`, `templates.test.ts`):*
  - `snapLayer` snaps to a neighbor edge within threshold and returns the guide; outside threshold it does not move.
  - `reorder` moves a layer up/down and is a no-op at the ends.
  - `duplicateLayer` offsets position and assigns a fresh id.
  - history: `push` after `undo` truncates the redo stack; `undo`/`redo` round-trip the exact doc; bounds don't throw.
  - `offBrandColors` flags a raw `#ff00ff` layer and passes a `token:primary` layer.
  - every `templates.ts` factory returns a doc that **passes `SceneDocSchema`** (Chunk A) and uses only `token:` colors.
- *Client (new client vitest + RTL):*
  - StudioScreen renders a scene's layers; selecting a layer shows the inspector; an undo button reverts the last text edit. (A thin smoke layer — the logic lives in the pure tests above.)

---

## Chunk D — Reels, AI studio actions, v1 cleanup

**Goal:** scene-based reel output, the AI generation actions, and removal of the dead v1 canvas path.

**Files:** `server/src/render/reel-composite.ts` (new), `server/src/generation/layout.ts` (new, auto-layout), `server/src/http/routes/studio.ts` (AI actions), `client/src/components/studio/ReelTimeline.tsx`, deletions: `server/src/media/still-bake.ts`, `client/src/lib/canvas-export.ts`, `client/src/lib/canvas-doc.ts` + the DOM overlay.

**Work:**
1. **Reel compositing** — render each timeline keyframe/layer to a PNG, build an ffmpeg filtergraph `overlay=enable='between(t,a,b)'` from the timeline's timed layers, composite over the base clip, reuse `whichFfmpeg` + cover extraction from `reel-burn.ts`. Keep the filtergraph **string builder pure**.
2. **AI actions** (`POST /api/posts/:id/studio/:action`): generate-background, 4 variations, replace-from-stock, rewrite/punch-up text, alternate hooks, and **auto-layout from brief** (`generation/layout.ts`: brief → `SceneDoc`). Each produces `assets` and (per Phase 2) could enqueue a job; for now run inline behind a cost label.
3. **Reel timeline UI** — lanes with timed text cues and a cover-frame picker.
4. **Delete v1** — remove `still-bake.ts`, `canvas-export.ts`, `canvas-doc.ts`, and the DOM overlay once the Konva path renders everything; update imports.

**Unit tests** (`server/src/render/__tests__/reel-composite.test.ts`, `server/src/generation/__tests__/layout.test.ts`):
- `buildOverlayFilter(timeline)` emits `between(t,a,b)` windows matching each timed layer's start/end, in order, and handles a single-beat timeline.
- `timelineSegments(doc)` maps `SceneTimeline` beats → non-overlapping `[start,end]` windows covering the duration.
- `autoLayout(brief, tokens, format)` returns a schema-valid `SceneDoc` with a hook text layer and a background, using only `token:` colors; a carousel brief yields the right page count.
- stock/asset **dedup**: registering the same asset twice (same sha256) returns the existing row (covers the `/assets` POST path).
- generate-background **prompt builder** is pure and includes the brand render_style + negative prompt.
- **v1-removal guard:** a test (or `tsc`) asserting nothing imports `still-bake`/`canvas-export`/`canvas-doc` after deletion.

---

## Execution order & dependencies

| Chunk | Depends on | Effort | Unlocks |
|---|---|---|---|
| A — schema/resolve/backfill | — | ~5h | Trusted model for B–D |
| B — render endpoint + golden | A | ~6h | Publish-quality assets, parity proof |
| C — editor features | A | ~10h | The actual studio UX |
| D — reels + AI + cleanup | A, B | ~8h | Reels, AI actions, dead-code removal |

B and C can run in parallel once A lands (B is server, C is client/shared).

## Exit criteria (Phase 3)
- `pnpm typecheck` + `pnpm test` pass (server + new client suite).
- Golden render test passes client↔server (<1% pixel diff) under `GOLDEN=1`.
- An approved scene renders with a **stable hash** and re-render is skipped when unchanged.
- A post built **from scratch** and a **fully-AI** post both render and publish end to end.
- `still-bake.ts`, `canvas-export.ts`, `canvas-doc.ts` and the DOM overlay are deleted with no dangling imports.
- The Studio passes `inspect.mjs --app` with 0 FAIL at 1440/768/390.
