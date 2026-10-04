import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { AttentionMarkLine, RecordedBlock } from './AttentionMarks'

describe('LIVE.2 — the recorded block and the history lines', () => {
  it('numbers only, in the reader\'s language, with a wrapping layout (no fixed width: 390 px safe)', () => {
    const html = renderToStaticMarkup(
      <RecordedBlock pt={false} recorded={{ firstAt: '2026-08-01T10:00:00.000Z', lastAt: '2026-08-02T10:00:00.000Z', turns: 12, toolCalls: 40, toolsFailed: 2, toolsDenied: 0, models: ['claude-opus-5-5'], tokens: { input: 1500, output: 20 } }} />,
    )
    expect(html).toContain('data-recorded-metrics')
    expect(html).toContain('Turns')
    expect(html).toContain('40 (2 failed)')
    expect(html).toContain('numbers only')
    expect(html).toContain('flex-wrap:wrap')
    expect(html).not.toMatch(/width:\s*\d+px/)
    expect(html).not.toContain('<button')
  })
  it('a mark is a note, never a control', () => {
    const html = renderToStaticMarkup(<AttentionMarkLine pt mark={{ at: 'x', kind: 'approval', via: 'screen', how: 'answered-here', blockedMs: 4000 }} />)
    expect(html).toContain('Pediu sua aprovação · respondido aqui · esperou 4 s')
    expect(html).toContain('role="note"')
    expect(html).not.toContain('<button')
  })
})
