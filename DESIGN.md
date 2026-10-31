# Design system

<!-- impeccable:design-schema 1 -->

## World

Press-check / blueline proof sheet for an Operate dashboard. Cool pale sheet ground, printer-blue structure rules, magenta used only as the “needs OK” mark. One grotesque throughout (Source Sans 3). Flat panels, 1px hairlines, no nested cards, no icon KPI tiles.

## Color

| Token | Value | Role |
|---|---|---|
| background | `#f2f5f8` | Sheet ground |
| foreground / primary | `#15191e` | Ink |
| card | `#ffffff` | Work surfaces |
| border / input | `#c9d3de` | Hairlines |
| rule | `#3d6ea8` | Structure, active underline, registration |
| pending | `#c9184a` | Needs OK / approve CTA |
| ok | `#0f7a4a` | Passed / published |
| warn | `#a15c07` | Revise |
| muted-foreground | `#5a6573` | Secondary labels |

## Type

Source Sans 3, 400–700. UI scale ~1.125. Uppercase 11px labels at ~0.08em tracking for field/column chrome. Tabular mono for ids and counts.

## Layout

Sticky top shell (brand · tabs · actions) with a 1px rule hairline under the bar. Content max-width 1200px. Metrics as a single ruled strip of type, not separate cards. Tables and sections use flat borders.

## Components

shadcn-style primitives under `client/src/components/ui` wired to CSS variables via Tailwind v4 `@theme inline`. Buttons: ink primary, outline secondary, magenta `pending` for approve. Status badges use soft fills of pending/ok/warn.

## Signature

Crosshair mark in the brand lockup; blue registration rule under the header; “Needs OK” language instead of generic pending.
