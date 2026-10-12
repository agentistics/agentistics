import { describe, expect, test } from 'bun:test'
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

function render(sessions: SessionMeta[]): string {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { innerWidth: 1280 },
  })
  return renderToStaticMarkup(<HighlightsBoard sessions={sessions} projects={[]} lang="en" />)
}

describe('token highlight cards', () => {
  test('show the shared unavailable dash when every session lacks measured tokens', () => {
    const html = render([
      session({ session_id: 'missing-1', input_tokens: 0, output_tokens: 0, tokens_unavailable: true }),
      session({ session_id: 'missing-2', input_tokens: 0, output_tokens: 0, tokens_unavailable: true }),
    ])

    expect(html).toContain('Most input tokens')
    expect(html).toContain('Most output tokens')
    expect((html.match(/—/g) ?? []).length).toBe(2)
    expect(html).toMatch(/Most input tokens[\s\S]*?—/)
    expect(html).toMatch(/Most output tokens[\s\S]*?—/)
  })

  test('ranks measured sessions and ignores unavailable sessions in a mixed scope', () => {
    const html = render([
      session({ session_id: 'missing', input_tokens: 999_999, output_tokens: 999_999, tokens_unavailable: true }),
      session({ session_id: 'measured', input_tokens: 1234, output_tokens: 5678 }),
    ])

    expect(html).toMatch(/Most input tokens[\s\S]*?1\.2K/)
    expect(html).toMatch(/Most output tokens[\s\S]*?5\.7K/)
  })
})
