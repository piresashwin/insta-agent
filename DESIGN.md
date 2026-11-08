# Design system

**Style:** accent-ladder (light). Seed 1279302896.
**Direction:** raspberry `#b8336a` — full hue on small marks only, pale tints for areas.

## Typeface

DM Sans, loaded from Google Fonts. Weights 400 / 500 / 600 (700 for page titles only).
Tabular figures on every number. Sentence case; no tracked capitals.

## Colour tokens (index.css :root)

| Token | Value | Use |
|---|---|---|
| `--ground` | `#fbf7f8` | Page background |
| `--surface` | `#ffffff` | Cards, panels |
| `--raised` | `#f3f4f6` | Hover bg, chips |
| `--active` | `#fdf2f7` | Active nav row, selected row |
| `--border` | `#e5e7eb` | Decorative hairlines |
| `--rule` | `#f2f2f2` | Section rules |
| `--control` | `#8f96a3` | Field outlines (≥3:1) |
| `--text` | `#111827` | Primary text |
| `--muted` | `#5f6672` | Secondary text |
| `--faint` | `#6b6b6b` | Tertiary text |
| `--primary` | `#1d1f20` | Secondary "do" buttons |
| `--accent` | `#b8336a` | Approve button, active marks, count badge |
| `--accent-soft` | `#fdf2f7` | Accent tint areas |
| `--accent-track` | `#f8dbe8` | Budget bar, progress tracks |
| `--accent-ink` | `#6b1d3e` | Text on accent tint |
| `--positive` | `#247b50` | Success states |
| `--negative` | `#c4242a` | Error states |
| `--warning` | `#92400e` | Warning states |

## Layout tokens

| Token | Value |
|---|---|
| `--sidebar-width` | `230px` |
| `--topbar` | `64px` |
| `--nav-row` | `40px` |
| `--gap` | `24px` |
| `--radius-card` | `8px` |
| `--radius-control` | `6px` |
| `--radius-chip` | `4px` |

## Shell: ruled T-frame

**Sidebar (230px, on `--ground`, divided by 1px `--border` rules)**
- Product mark at top
- Nav items on `--nav-row` pitch: Home · Inbox·count · Calendar · Studio · Insights · Brand · Activity
- Pinned: Settings · Budget line (`$X of $10 · Nov` on `--accent-track`) · Model status dot

**Top bar (64px)**
- Breadcrumb · ⌘K search centred · Brand switcher at right

**Phone:** 56px top bar + bottom bar (Home · Inbox · Calendar · Studio · More)

## Status glossary

Defined in `shared/src/index.ts:STATUS_GLOSSARY`. Single source of truth for labels and tones.
Never duplicate these in component code — import `statusLabel()` and `statusToneFor()`.

| Status | Label | Tone |
|---|---|---|
| draft | Draft | draft |
| pending_approval | Needs OK | pending |
| changes_requested | Changes requested | info |
| approved | Copy approved | positive |
| media_generating | Generating media | info |
| media_ready | Media ready for review | pending |
| staged | Ready to publish | positive |
| published | Live | positive |
| failed | Failed | negative |

## Rules

- One surface tone **or** a 1px border — never both.
- Shadows only on floating elements (menus, dialogs, popovers, composer).
- Icons: `lucide-react` at 16px / 1.5px stroke, grey. Only in nav, before a label, or as single affordance.
- Motion is feedback only: press, hover, focus, sheet open, row arrive. 120–180ms. `prefers-reduced-motion` fallback.
- Colour budget: 3–10% of pixels, nearly all tints.
- **Not allowed:** gradients, glows, glass, violet/indigo, a second accent family, emoji in UI chrome, icons in tinted squares.

## Accessibility

- Text contrast ≥4.5:1; field outlines ≥3:1 (`--control #8f96a3`).
- Focus ring: 2px `--accent`, offset 2px, `--radius-chip`.
- Keyboard-reachable rows, `aria-pressed` on toggles, Radix focus traps.
- Min 11px for pills and labels; nothing below 11px.

## Check process

1. `inspect.mjs --app --out .taste-skill/before` before any design changes.
2. After each screen: `inspect.mjs --app` at 1440, 768 and 390 until 0 FAIL.
3. After Phase 2: `inspect.mjs --app --out .taste-skill/after` and compare.
4. `@axe-core/playwright` — zero serious violations on every route.
