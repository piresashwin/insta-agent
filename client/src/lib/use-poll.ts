import { useEffect, useRef, useState } from 'react'

/** Lightweight interval poller (no react-query) for PostScreen progress. */
export function usePoll<T>(
  fn: (() => Promise<T>) | null,
  isDone: (v: T) => boolean,
  onDone: (v: T) => void,
  intervalMs = 1500,
): { value: T | null } {
  const [value, setValue] = useState<T | null>(null)
  const onDoneRef = useRef(onDone)
  const isDoneRef = useRef(isDone)
  onDoneRef.current = onDone
  isDoneRef.current = isDone

  useEffect(() => {
    if (!fn) {
      setValue(null)
      return
    }
    let cancelled = false
    let timer: ReturnType<typeof setInterval> | null = null

    const tick = async () => {
      try {
        const v = await fn()
        if (cancelled) return
        setValue(v)
        if (isDoneRef.current(v)) {
          if (timer) clearInterval(timer)
          timer = null
          onDoneRef.current(v)
        }
      } catch {
        /* keep polling */
      }
    }

    void tick()
    timer = setInterval(() => void tick(), intervalMs)
    return () => {
      cancelled = true
      if (timer) clearInterval(timer)
    }
  }, [fn, intervalMs])

  return { value }
}
