import { afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SessionMeta } from '@agentistics/core'
import { HighlightsBoard } from './HighlightsBoard'

const session = (over: Partial<SessionMeta> = {}): SessionMeta => ({
  session_id: 's1',
  harness: 'claude',
  project_path: '/repo',
  first_prompt: 'prompt',
  input_tokens: 100,
  output_tokens: 50,
  ...over,
} as SessionMeta)

// bun runs every test file in one process: a `window` left behind (or left non-writable) breaks the
// next file that installs its own, so each render puts the original back.
const hadWindow = Object.prototype.hasOwnProperty.call(globalThis, 'window')
const originalWindow = (globalThis as Record<string, unknown>).window
afterEach(() => {
  if (hadWindow) Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: originalWindow })
  else delete (globalThis as Record<string, unknown>).window
})

function render(sessions: SessionMeta[]): string {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: { innerWidth: 1280 },
  })
  return renderToStaticMarkup(<HighlightsBoard sessions={sessions} projects={[]} lang="en" />)
}

function cardBetween(html: string, label: string, nextLabel: string): string {
  const start = html.indexOf(`>${label}</span>`)
  const end = html.indexOf(`>${nextLabel}</span>`, start + 1)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  return html.slice(start, end)
}

describe('token highlight cards', () => {
  test('show the shared unavailable dash when every session lacks measured tokens', () => {
    const html = render([
      session({ session_id: 'missing-1', input_tokens: 0, output_tokens: 0, tokens_unavailable: true }),
      session({ session_id: 'missing-2', input_tokens: 0, output_tokens: 0, tokens_unavailable: true }),
    ])

    const inputCard = cardBetween(html, 'Most input tokens', 'Most output tokens')
    const outputCard = cardBetween(html, 'Most output tokens', 'Most messages')
    expect(inputCard).toMatch(/class="hl-value"[^>]*>—<\/div>/)
    expect(outputCard).toMatch(/class="hl-value"[^>]*>—<\/div>/)
    expect(inputCard).not.toContain('prompt')
    expect(inputCard).not.toContain('/repo')
    expect(outputCard).not.toContain('prompt')
    expect(outputCard).not.toContain('/repo')
  })

  test('ranks measured sessions and ignores unavailable sessions in a mixed scope', () => {
    const html = render([
      session({ session_id: 'missing', input_tokens: 999_999, output_tokens: 999_999, tokens_unavailable: true }),
      session({ session_id: 'measured', input_tokens: 1234, output_tokens: 5678 }),
    ])

    expect(cardBetween(html, 'Most input tokens', 'Most output tokens')).toMatch(/class="hl-value"[^>]*>1\.2K<\/div>/)
    expect(cardBetween(html, 'Most output tokens', 'Most messages')).toMatch(/class="hl-value"[^>]*>5\.7K<\/div>/)
  })
})
