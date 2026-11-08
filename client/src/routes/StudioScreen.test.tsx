/**
 * Thin Studio smoke tests — intentionally does NOT mount react-konva Stage.
 * jsdom has no real canvas; Konva mounts are flaky. Pure editor rules live in
 * server scene-editor tests; this harness only covers history + inspector wiring.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React, { useState, useCallback } from 'react'
import {
  defaultSceneDoc,
  pushHistory,
  undoHistory,
  createHistory,
  historyCurrent,
  type SceneDoc,
  type SceneTextLayer,
} from '@instagram-agent/shared'

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({}),
}))

vi.mock('../api', () => ({
  getPost: vi.fn(),
  getPostScene: vi.fn(),
  savePostScene: vi.fn(),
  createPost: vi.fn(),
  listBrandProfiles: vi.fn(async () => ({ brands: [] })),
  listAssets: vi.fn(async () => ({ assets: [] })),
  createAsset: vi.fn(),
}))

/** Minimal harness mirroring Studio history + inspector wiring. */
function StudioSmokeHarness({ initial }: { initial: SceneDoc }) {
  const [history, setHistory] = useState(() => createHistory(initial))
  const doc = historyCurrent(history)
  const layer = doc.pages[0].layers[0] as SceneTextLayer | undefined
  const [selectedId, setSelectedId] = useState(layer?.id ?? null)

  const push = useCallback((next: SceneDoc) => {
    setHistory((h) => pushHistory(h, next))
  }, [])

  function updateText(text: string) {
    if (!layer) return
    const next: SceneDoc = {
      ...doc,
      pages: [
        {
          ...doc.pages[0],
          layers: doc.pages[0].layers.map((l) =>
            l.id === layer.id && l.type === 'text' ? { ...l, text } : l,
          ),
        },
      ],
    }
    push(next)
  }

  return (
    <div>
      <button
        data-testid="undo-btn"
        disabled={history.idx <= 0}
        onClick={() => setHistory((h) => undoHistory(h))}
      >
        Undo
      </button>
      <ul data-testid="layer-list">
        {doc.pages[0].layers.map((l) => (
          <li key={l.id}>
            <button data-testid={`layer-${l.id}`} onClick={() => setSelectedId(l.id)}>
              {l.type === 'text' ? l.text : l.type}
            </button>
          </li>
        ))}
      </ul>
      {selectedId && layer && (
        <div data-testid="inspector">
          <input
            data-testid="inspector-text"
            value={layer.text}
            onChange={(e) => updateText(e.target.value)}
          />
        </div>
      )}
    </div>
  )
}

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

describe('StudioScreen smoke', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders a scene\'s layers; selecting shows inspector; undo reverts text edit', async () => {
    const doc = defaultSceneDoc('feed')
    doc.pages[0].layers = [
      {
        id: 'l_hook',
        type: 'text',
        text: 'Original hook',
        x: 40,
        y: 40,
        w: 800,
        h: 120,
        fontSize: 48,
        color: 'token:primary',
      },
    ]

    wrap(<StudioSmokeHarness initial={doc} />)

    expect(screen.getByTestId('layer-list')).toBeInTheDocument()
    expect(screen.getByText('Original hook')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('layer-l_hook'))
    expect(screen.getByTestId('inspector')).toBeInTheDocument()

    const input = screen.getByTestId('inspector-text') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Edited hook' } })
    expect(input.value).toBe('Edited hook')

    fireEvent.click(screen.getByTestId('undo-btn'))
    await waitFor(() => {
      expect((screen.getByTestId('inspector-text') as HTMLInputElement).value).toBe('Original hook')
    })
  })
})
