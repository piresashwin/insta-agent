import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Inspector } from './Inspector'
import { defaultSceneDoc, type SceneTextLayer } from '@instagram-agent/shared'

describe('Inspector', () => {
  it('shows empty state when no layer is selected', () => {
    const doc = defaultSceneDoc('feed')
    render(
      <Inspector layer={null} doc={doc} tokens={doc.tokens} onUpdate={() => undefined} />,
    )
    expect(screen.getByTestId('inspector-empty')).toBeInTheDocument()
  })

  it('shows text field for a selected text layer and warns on off-brand color', () => {
    const doc = defaultSceneDoc('feed', {
      colors: { primary: '#b8336a', background: '#fff' },
      fonts: {},
    })
    const layer: SceneTextLayer = {
      id: 'l1',
      type: 'text',
      text: 'Hello studio',
      x: 0,
      y: 0,
      w: 200,
      h: 40,
      fontSize: 32,
      color: '#ff00ff',
    }
    doc.pages[0].layers = [layer]
    const onUpdate = vi.fn()
    render(
      <Inspector layer={layer} doc={doc} tokens={doc.tokens} onUpdate={onUpdate} />,
    )
    expect(screen.getByTestId('inspector')).toBeInTheDocument()
    expect(screen.getByTestId('off-brand-warning')).toBeInTheDocument()
    const input = screen.getByTestId('inspector-text') as HTMLInputElement
    expect(input.value).toBe('Hello studio')
    fireEvent.change(input, { target: { value: 'Updated' } })
    expect(onUpdate).toHaveBeenCalledWith('l1', expect.objectContaining({ text: 'Updated' }))
  })
})
