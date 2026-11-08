/**
 * Deterministic Instagram rule checks — run before post_review so mechanical
 * failures are never left to model judgement. Returns human-readable failures.
 */
import { IG, findBait, fitCaption, parseHashtags, wordCount } from '../instagram-rules'

export type LintInput = {
  format?: string | null
  hook_on_image?: string | null
  caption?: string | null
  hashtags?: string | null
  first_line?: string | null
  cta?: string | null
  slides?: Array<{ text?: string | null; role?: string | null }> | null
  beats?: Array<{ t_start?: number | null; on_screen_text_intent?: string | null }> | null
  duration_sec?: number | null
}

export function lintDraft(d: LintInput): string[] {
  const out: string[] = []
  const format = String(d.format || 'feed').toLowerCase()
  const caption = (d.caption || '').trim()
  const hashtags = (d.hashtags || '').trim()

  // On-image copy
  if (format !== 'carousel' && wordCount(d.hook_on_image) > IG.onImageMaxWords) {
    out.push(`On-image hook has ${wordCount(d.hook_on_image)} words (max ${IG.onImageMaxWords}).`)
  }

  // Caption / first line / length
  if (!caption) out.push('Caption is empty.')
  const firstLine = (d.first_line || caption.split('\n')[0] || '').trim()
  if (firstLine.length > IG.firstLineMax) {
    out.push(`First line is ${firstLine.length} chars (max ${IG.firstLineMax} before “more”).`)
  }
  const joinedLen = [caption, hashtags].filter(Boolean).join('\n\n').length
  if (joinedLen > IG.captionMax) {
    out.push(
      `Caption + hashtags = ${joinedLen} chars (max ${IG.captionMax}); publish would trim to ${fitCaption(caption, hashtags).length}.`
    )
  }

  // Hashtags
  const tags = parseHashtags(hashtags)
  if (tags.length > IG.hashtagMax) out.push(`${tags.length} hashtags (max ${IG.hashtagMax}).`)
  if (tags.length === 0) out.push('No hashtags.')
  const generic = tags.filter((t) => IG.genericHashtags.has(`#${t.toLowerCase()}`))
  if (generic.length) out.push(`Generic hashtags with no search value: ${generic.map((t) => `#${t}`).join(' ')}.`)

  // Bait
  const bait = findBait(`${caption}\n${d.cta || ''}`)
  if (bait.length) out.push(`Engagement bait phrase(s) Meta demotes: ${bait.map((b) => `“${b}”`).join(', ')}.`)

  // Carousel
  if (format === 'carousel') {
    const slides = d.slides || []
    if (slides.length < IG.carouselMinSlides || slides.length > IG.carouselMaxApi) {
      out.push(`Carousel has ${slides.length} slides (want ${IG.carouselMinSlides}–${IG.carouselMaxApi}).`)
    }
    slides.forEach((s, i) => {
      const max = i === 0 ? IG.coverMaxWords : IG.onImageMaxWords
      const n = wordCount(s.text)
      if (n > max) out.push(`Slide ${i + 1} text has ${n} words (max ${max}).`)
      if (!n) out.push(`Slide ${i + 1} has no on-image text.`)
    })
    const last = slides[slides.length - 1]
    if (last && !/\b(save|share)\b/i.test(last.text || '')) {
      out.push('Last carousel slide must say Save or Share.')
    }
  }

  // Reel
  if (format === 'reel') {
    const dur = Number(d.duration_sec) || 0
    const beats = [...(d.beats || [])].sort((a, b) => Number(a.t_start) - Number(b.t_start))
    if (!dur) out.push('Reel has no duration_sec.')
    else if (dur < IG.reelDuration.min || dur > IG.reelDuration.max) {
      out.push(`Reel duration ${dur}s outside ${IG.reelDuration.min}–${IG.reelDuration.max}s (one clip).`)
    }
    if (beats.length < 2) out.push('Reel needs ≥2 beats (hook + CTA).')
    if (beats[0] && Number(beats[0].t_start) > 1.5) {
      out.push(`First beat starts at ${beats[0].t_start}s (hook must land by 1.5s).`)
    }
    for (let i = 0; i < beats.length; i++) {
      const t = Number(beats[i].t_start) || 0
      if (dur && t >= dur) out.push(`Beat ${i + 1} at ${t}s is past the ${dur}s clip.`)
      const isLast = i + 1 >= beats.length
      const next = isLast ? dur : Number(beats[i + 1].t_start)
      // Small tolerance between beats; the closing CTA may hold a little longer.
      const maxGap = isLast ? 5 : 3.5
      if (dur && next - t > maxGap) {
        out.push(`Gap of ${(next - t).toFixed(1)}s after beat ${i + 1} (keep ≤${isLast ? 5 : 3}s).`)
      }
      const n = wordCount(beats[i].on_screen_text_intent)
      if (n > IG.onImageMaxWords) out.push(`Beat ${i + 1} text has ${n} words (max ${IG.onImageMaxWords}).`)
    }
  }

  return out
}
