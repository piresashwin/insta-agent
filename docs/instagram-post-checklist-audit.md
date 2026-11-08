# Checklist vs generation pipeline — audit

Maps [`instagram-post-checklist.md`](./instagram-post-checklist.md) to code that drafts posts and compiles image prompts.  
**Status:** `enforced` (deterministic) · `prompted` (LLM instruction only) · `missing` (not in pipeline) · `partial`

Reviewed: `content-planning`, `caption-writing`, `image-reel-generation`, `post-review`, `agent/loop`, `agent/start-run`, `prompts/format-templates`, week-plan topic hints.

**Updated:** checklist hardening — hook split, scene-depicts-tip, carousel roles, reel beats, format CTAs, required gate review.

---

## Universal

| Checklist | Status | Where | Notes |
|-----------|--------|-------|-------|
| One job | **prompted** | `content-planning` `job` enum | educate / entertain / feel_seen |
| Specific audience | **prompted** | `audience` + `audience_problem` | Named pain required in schema describe |
| Hook = promise | **partial** | `hook` + `hook_on_image` (≤12 words, clipped) | Preview-alone still soft in review |
| Value without caption | **prompted** | Loop + media scene-depicts-tip + gate | Enforced in review gate, not deterministic scene parse |
| CTA matches format | **prompted** | `caption-writing` format rules | Feed save/comment; reel follow/share/try; carousel save/share |
| Truth test | **prompted** | `post_review` checklist + gate | Required before finish; one revision then HITL |

---

## Feed

| Checklist | Status | Where | Notes |
|-----------|--------|-------|-------|
| ≤12 words on-image | **enforced** / **prompted** | `hook_on_image` + `shortOnImageText(..., maxWords=12)` | Word + char cap |
| Restrained type size | **prompted** | `typeRecipe` SIZE line | Soft for image model |
| Visual shows the tip | **prompted** | Feed block in `media_prompts` | Forbids lifestyle-only when teaching |
| Caption structure | **prompted** | Caption format=feed rules | hook → tip → CTA |
| First line before “more” | **partial** | `first_line` aligned to caption start, ~125 chars | Soft equal check |

---

## Reel

| Checklist | Status | Where | Notes |
|-----------|--------|-------|-------|
| 0–3s hook | **prompted** | `beats[]` first beat | Mapped to timed_cues in start-run |
| Tip immediately | **prompted** | Reel media block | Soft |
| Beat every 1–2s | **prompted** | Beat sheet instructions | Soft |
| One idea + payoff CTA | **partial** | Last beat → timed cue CTA | Soft CTA language |
| Intentional length | **yes** | `duration_sec` (6–15s, one Runware clip) | Seeded into `prompt_vars.duration`, passed to Runware |

---

## Carousel

| Checklist | Status | Where | Notes |
|-----------|--------|-------|-------|
| Slide 1 hook ~6–10 words | **enforced** / **prompted** | Cover word cap 10 + role=`cover` | |
| One idea per slide | **prompted** | Carousel role block | Soft |
| Hook → why → steps → trap → recap → CTA | **prompted** | Roles when maxSlides≥5 | Compressed under 5 |
| Last slide Save/Share | **partial** | Prompt + post-normalize append “Save this” | |
| No filler | **prompted** | “cut rather than pad” | Soft |

---

## Image / plate prompts

| Concern | Status | Notes |
|---------|--------|-------|
| Scene vs lettering split | **enforced** | Compiler Exact SoT + scene-only scrub |
| Lettering SoT | **enforced** | `hook_on_image` / slide text / reel cues |
| Type size | **prompted** | `typeRecipe` |
| Visual = tip depiction | **prompted** | Media skill + review gate |
| Reel beat sheet | **prompted** | `beats` + motion brief summary |
| Stock keywords | **prompted** | Unchanged |

---

## 10-second gate

| Gate question | In pipeline? |
|---------------|--------------|
| Stop scrolling? | **Yes** — `post_review.gate.stop_scroll` (required tool) |
| Learn without caption? | **Yes** — `gate.value_without_caption` |
| Save or send? | **Yes** — `gate.save_or_send` |

`approved` only if score ≥ 7 **and** all three gate booleans true. Loop requires `post_review` before finish; one revision on fail, then draft surfaces for HITL.

---

## How to verify a post

1. Open [`instagram-post-checklist.md`](./instagram-post-checklist.md).  
2. Score the draft/media.  
3. Compare `agent_output.review.gate` and `hook_on_image` / slide roles on the post.
