import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import type { SessionMeta } from '@agentistics/core'
import { ActionsContent } from './ActionsPage'

const run = (id: string, remote: string, extra: Partial<SessionMeta> = {}) => ({
  session_id: id, ci: true, git_remote: remote, title: 'Read image files and copy the complete result',
  project_path: '/home/runner/work/x', harness: 'codex', model: 'example', start_time: '2026-10-18T08:00:00Z', ...extra,
}) as SessionMeta
function render(sessions: SessionMeta[], lang: 'pt' | 'en', width: number) {
  const root = globalThis as { window?: unknown }
  const previous = root.window
  root.window = { innerWidth: width }
  try { return renderToStaticMarkup(<MemoryRouter><ActionsContent sessions={sessions} lang={lang} onSelect={() => {}} /></MemoryRouter>) }
  finally { if (previous === undefined) delete root.window; else root.window = previous }
}
for (const lang of ['pt', 'en'] as const) for (const width of [390, 1440]) describe(`Actions ${lang} at ${width}px`, () => {
  test('repository groups have compact runs with full titles, localized dates and 44px actions', () => {
    const sessions = [run('a', 'github.com/acme/alpha'), run('b', 'github.com/acme/beta')]
    const html = render(sessions, lang, width)
    for (const name of ['acme/alpha', 'acme/beta']) expect(html.match(new RegExp(name, 'g'))).toHaveLength(1)
    expect(html.match(/Read image files and copy the complete result<\/div>/g)).toHaveLength(2)
    expect(html).toContain(new Date(sessions[0]!.start_time).toLocaleString(lang === 'pt' ? 'pt-BR' : 'en-US'))
    expect(html).toContain('Codex CLI')
    expect(html).toContain('Codex CLI · example</span>')
    expect(html).toContain('border:1px solid var(--border);border-radius:8px;background:var(--bg-elevated);color:var(--text-primary)')
    expect(html).toContain('flex:0 0 auto;min-height:44px;min-width:44px')
    expect(html).not.toContain('border-top:1px solid var(--border)')
    expect(html.match(/min-height:44px/g)).toHaveLength(2)
    expect(html).toContain('white-space:normal')
    for (const repeated of ['Agrupar por', 'Group by', '/home/runner', 'text-overflow:ellipsis', '1 sessões']) expect(html).not.toContain(repeated)
  })
  test('single run and repository use singular labels and unknown data stays N/A', () => {
    const html = render([run('a', 'github.com/acme/alpha', { start_time: 'invalid', harness: undefined })], lang, width)
    expect(html).toContain(lang === 'pt' ? '1 execução em 1 repositório' : '1 run in 1 repository')
    expect(html).toContain('N/A')
    expect(html).toContain(lang === 'pt' ? 'Execuções de CI' : 'Actions')
  })
  test('non-CI sessions do not appear', () => {
    const html = render([run('a', 'repo', { ci: false })], lang, width)
    expect(html).toContain(lang === 'pt' ? 'Nenhuma execução de CI registrada.' : 'No CI runs recorded.')
    expect(html).not.toContain('Read image files')
  })
})
