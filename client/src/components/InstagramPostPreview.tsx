/**
 * Instagram-faithful chrome around the composed proof (feed / carousel / reel).
 * Read-only feel; carousel dots/chevrons change the active slide via parent.
 */
import type { CanvasDoc, Post, PostFormat, PostSlide } from '@instagram-agent/shared'
import { FORMAT_EXPORT } from '@instagram-agent/shared'
import { bakeSourceUrl } from '../lib/media-url'
import { cn } from '../lib/utils'

type Props = {
  post: Post
  format: PostFormat
  slides: PostSlide[]
  activeIdx: number
  onActiveIdx: (idx: number) => void
  doc: CanvasDoc
  displayUrl: string | null
  username?: string | null
  frameH: number
  onFrameRef?: (el: HTMLDivElement | null) => void
  /** Reel playhead (seconds) — retained for API compat; overlays removed (Konva/Studio path). */
  currentTime?: number
  /** @deprecated DOM overlays removed; baked media is shown as-is. */
  showOverlays?: boolean
}

function HeartIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M12 21s-6.5-4.35-9.33-8.1C.7 10.1 1.2 6.6 4.1 5.1 6.2 4 8.7 4.6 10 6.3 11.3 4.6 13.8 4 15.9 5.1c2.9 1.5 3.4 5 1.43 7.8C18.5 16.65 12 21 12 21z" />
    </svg>
  )
}
function CommentIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M21 12a8.5 8.5 0 0 1-8.5 8.5H5l-3 3V12A8.5 8.5 0 1 1 21 12z" />
    </svg>
  )
}
function ShareIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M22 2 11 13" />
      <path d="M22 2 15 22l-4-9-9-4 20-7z" />
    </svg>
  )
}
function SaveIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M19 21 12 16 5 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
    </svg>
  )
}

function ProofMedia({
  doc,
  displayUrl,
  aspect,
  onFrameRef,
}: {
  doc: CanvasDoc
  displayUrl: string | null
  aspect: string
  frameH?: number
  interactive?: boolean
  onFrameRef?: (el: HTMLDivElement | null) => void
  currentTime?: number
  showOverlays?: boolean
}) {
  const fit = doc.background?.fit || 'cover'
  const mediaSrc = displayUrl ? bakeSourceUrl(displayUrl) : null
  return (
    <div
      ref={onFrameRef}
      className="relative w-full overflow-hidden bg-black"
      style={{ aspectRatio: aspect }}
    >
      {mediaSrc ? (
        /\.mp4(\?|$)/i.test(mediaSrc) ? (
          <video
            key={mediaSrc}
            src={mediaSrc}
            className={cn(
              'absolute inset-0 h-full w-full',
              fit === 'contain' ? 'object-contain' : 'object-cover'
            )}
            style={{
              objectPosition: `${(doc.background?.focusX ?? 0.5) * 100}% ${(doc.background?.focusY ?? 0.5) * 100}%`,
            }}
            autoPlay
            muted
            loop
            playsInline
          />
        ) : (
          <img
            key={mediaSrc}
            src={mediaSrc}
            alt=""
            className={cn(
              'absolute inset-0 h-full w-full',
              fit === 'contain' ? 'object-contain' : 'object-cover'
            )}
            style={{
              objectPosition: `${(doc.background?.focusX ?? 0.5) * 100}% ${(doc.background?.focusY ?? 0.5) * 100}%`,
            }}
            draggable={false}
          />
        )
      ) : (
        <div className="absolute inset-0 flex items-center justify-center bg-neutral-900">
          <p className="text-xs text-white/50">No media</p>
        </div>
      )}
    </div>
  )
}

function Header({ username }: { username: string }) {
  const initial = (username || 'Y').slice(0, 1).toUpperCase()
  return (
    <div className="flex items-center gap-2.5 px-3 py-2.5">
      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-amber-400 via-rose-500 to-violet-600 p-[1.5px]">
        <div className="flex h-full w-full items-center justify-center rounded-full bg-white text-[11px] font-semibold text-neutral-800">
          {initial}
        </div>
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-semibold leading-tight text-neutral-900">{username}</p>
      </div>
      <span className="text-neutral-500" aria-hidden>
        •••
      </span>
    </div>
  )
}

function ActionRow() {
  return (
    <div className="flex items-center justify-between px-3 py-2 text-neutral-900">
      <div className="flex items-center gap-3.5">
        <HeartIcon />
        <CommentIcon />
        <ShareIcon />
      </div>
      <SaveIcon />
    </div>
  )
}

function CaptionBlock({
  username,
  hook,
  caption,
  hashtags,
}: {
  username: string
  hook?: string | null
  caption?: string | null
  hashtags?: string | null
}) {
  const body = (caption || hook || '').trim()
  const short = body.length > 120 ? `${body.slice(0, 120)}…` : body
  return (
    <div className="space-y-1 px-3 pb-3 text-[13px] leading-snug text-neutral-900">
      <p>
        <span className="font-semibold">{username}</span>{' '}
        <span className="text-neutral-800">{short || '—'}</span>
      </p>
      {hashtags?.trim() && (
        <p className="text-sky-700">{hashtags.trim().split(/\s+/).slice(0, 5).join(' ')}</p>
      )}
      <p className="text-[11px] uppercase tracking-wide text-neutral-400">Just now</p>
    </div>
  )
}

export function InstagramPostPreview({
  post,
  format,
  slides,
  activeIdx,
  onActiveIdx,
  doc,
  displayUrl,
  username,
  frameH,
  onFrameRef,
}: Props) {
  const name = (username || 'you').replace(/^@/, '')
  const aspect = FORMAT_EXPORT[format === 'carousel' ? 'carousel' : format].aspect
  const safeIdx = slides.length ? Math.min(activeIdx, slides.length - 1) : 0
  void frameH

  if (format === 'reel') {
    return (
      <div className="mx-auto w-full max-w-[280px] overflow-hidden rounded-[28px] border border-neutral-800 bg-black shadow-[0_12px_40px_rgba(0,0,0,0.25)]">
        <div className="relative">
          <ProofMedia
            doc={doc}
            displayUrl={displayUrl}
            aspect={aspect}
            onFrameRef={onFrameRef}
          />
          <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-between px-3 pt-3 text-white">
            <span className="text-sm font-semibold">Reels</span>
            <span className="text-lg">📷</span>
          </div>
          <div className="pointer-events-none absolute bottom-20 right-2 flex flex-col items-center gap-4 text-white">
            <div className="flex flex-col items-center gap-1">
              <HeartIcon />
            </div>
            <div className="flex flex-col items-center gap-1">
              <CommentIcon />
            </div>
            <ShareIcon />
            <SaveIcon />
            <div className="mt-1 h-7 w-7 rounded-md border border-white/80 bg-neutral-700" />
          </div>
          <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/30 to-transparent px-3 pb-4 pt-16 text-white">
            <p className="text-[13px] font-semibold">@{name}</p>
            <p className="mt-1 line-clamp-2 text-[12px] text-white/90">
              {(post.caption || post.hook || '').trim() || '—'}
            </p>
            <p className="mt-2 truncate text-[11px] text-white/70">♪ Original audio</p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto w-full max-w-[340px] overflow-hidden rounded-md border border-neutral-200 bg-white shadow-[0_8px_28px_rgba(21,25,30,0.12)]">
      <Header username={name} />
      <div className="relative">
        <ProofMedia
          doc={doc}
          displayUrl={displayUrl}
          aspect={aspect}
          onFrameRef={onFrameRef}
        />
        {format === 'carousel' && slides.length > 1 && (
          <>
            <span className="absolute right-2 top-2 rounded-full bg-black/60 px-2 py-0.5 text-[11px] font-medium tabular-nums text-white">
              {safeIdx + 1}/{slides.length}
            </span>
            {safeIdx > 0 && (
              <button
                type="button"
                aria-label="Previous slide"
                className="absolute left-2 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full bg-white/90 text-neutral-800 shadow"
                onClick={() => onActiveIdx(safeIdx - 1)}
              >
                ‹
              </button>
            )}
            {safeIdx < slides.length - 1 && (
              <button
                type="button"
                aria-label="Next slide"
                className="absolute right-2 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full bg-white/90 text-neutral-800 shadow"
                onClick={() => onActiveIdx(safeIdx + 1)}
              >
                ›
              </button>
            )}
          </>
        )}
      </div>
      {format === 'carousel' && slides.length > 1 && (
        <div className="flex items-center justify-center gap-1.5 py-2">
          {slides.map((s, i) => (
            <button
              key={s.id}
              type="button"
              aria-label={`Slide ${i + 1}`}
              onClick={() => onActiveIdx(i)}
              className={cn(
                'h-1.5 rounded-full transition-all',
                i === safeIdx ? 'w-1.5 bg-sky-500' : 'w-1.5 bg-neutral-300'
              )}
            />
          ))}
        </div>
      )}
      <ActionRow />
      <CaptionBlock
        username={name}
        hook={post.hook}
        caption={post.caption}
        hashtags={post.hashtags}
      />
    </div>
  )
}
