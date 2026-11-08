import '@testing-library/jest-dom/vitest'
import { vi } from 'vitest'
import React from 'react'

// jsdom has no ResizeObserver; StudioScreen's canvas sizing effect needs a stub
// so mounting the editor (even with react-konva stubbed below) doesn't throw.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(globalThis as any).ResizeObserver = ResizeObserverStub

// Konva needs canvas; stub react-konva for unit smoke tests.
vi.mock('react-konva', () => {
  const Stub = ({ children, ...props }: { children?: React.ReactNode; id?: string; [k: string]: unknown }) =>
    React.createElement('div', { 'data-konva': props.id ?? 'node', ...props }, children)
  return {
    Stage: Stub,
    Layer: Stub,
    Text: Stub,
    Rect: Stub,
    Ellipse: Stub,
    Transformer: Stub,
    Image: Stub,
    Line: Stub,
  }
})
