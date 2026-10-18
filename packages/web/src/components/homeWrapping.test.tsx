import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import type { SessionMeta } from '@agentistics/core'
import { HighlightsBoard } from './HighlightsBoard'
import { ToolMetricsPanel } from './ToolMetricsPanel'

for (const width of [390, 1440]) for (const lang of ['pt', 'en'] as const) test(`Home keeps long session and tool names at ${width}px in ${lang}`, () => {
  const root = globalThis as { window?: unknown }
  const previous = root.window
  root.window = { innerWidth: width }
  try {
    const title = 'Review the extremely long pull request title and its full implementation details '.repeat(3)
    const session = { session_id: 'long', title, harness: 'claude', project_path: '/runner/work',
      start_time: '2026-10-18T08:00:00Z', duration_minutes: 20, input_tokens: 100, output_tokens: 100,
      user_message_count: 3, assistant_message_count: 3, tool_counts: { Read: 1 } } as unknown as SessionMeta
    const highlights = renderToStaticMarkup(<HighlightsBoard sessions={[session]} projects={[]} lang={lang} />)
    expect(highlights).toContain(title.trim())
    expect(highlights).not.toContain('text-overflow:ellipsis')
    expect(highlights).not.toContain('-webkit-line-clamp')
    const tool = 'mcp__claude-in-chrome__javascript_tool'
    const tools = renderToStaticMarkup(<ToolMetricsPanel toolCounts={{ [tool]: 4 }} toolOutputTokens={{}} agentFileReads={{}} lang={lang} forcedMode="calls" />)
    expect(tools).toContain(tool)
    expect(tools).toContain('white-space:normal;overflow-wrap:anywhere')
    expect(tools).not.toContain('text-overflow:ellipsis')
  } finally { if (previous === undefined) delete root.window; else root.window = previous }
})

test('recent session list and grid titles wrap without a line clamp', () => {
  const source = readFileSync(new URL('./RecentSessions.tsx', import.meta.url), 'utf8')
  const title = source.slice(source.indexOf('const titleStyle:'), source.indexOf('\n\n  return (', source.indexOf('const titleStyle:')))
  expect(title).toContain("whiteSpace: 'normal'")
  expect(title).toContain("overflowWrap: 'anywhere'")
  expect(title).not.toContain('WebkitLineClamp')
  expect(source).not.toContain('textOverflow: \'ellipsis\'')
})

test('Home keeps the last session date and span in one wrapping group', () => {
  const home = readFileSync(new URL('../pages/HomePage.tsx', import.meta.url), 'utf8')
  const group = home.slice(home.indexOf("display: 'inline-flex', alignItems: 'baseline', flexWrap: 'wrap', gap: 6"))
  expect(group.slice(0, group.indexOf('</div>'))).toContain('derived.lastSessionDate')
  expect(group.slice(0, group.indexOf('</div>'))).toContain('derived.sessionSpanDays')
})
