import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import type { TaskEvent } from '../lib/tasks'
import { TaskActivityList } from './TaskActivityPage'
import { activityActor, activitySentence } from './taskActivity'

const event = (patch: Partial<TaskEvent> = {}): TaskEvent => ({
  id: 'e-aabbccdd', taskId: 't-3d092f5797', at: '2026-10-18T09:00:00Z',
  actor: 'session:688c52cc', kind: 'comment', ...patch,
})
const handback = event({ detail: '{"message":{"to":"6df955de67","kind":"handback","from":"688c52ccaa"}}' })

describe('board activity in human language', () => {
  test('message metadata becomes a sentence in both languages', () => {
    expect(activitySentence(handback, 'pt')).toBe('Enviou trabalho para revisão.')
    expect(activitySentence(handback, 'en')).toBe('Sent work for review.')
    for (const lang of ['pt', 'en'] as const) {
      for (const kind of ['block', 'question']) {
        expect(activitySentence(event({ detail: JSON.stringify({ message: { kind } }) }), lang)).not.toContain('{')
      }
      expect(activitySentence(event({ detail: '{broken' }), lang)).toBe(lang === 'pt' ? 'Adicionou um comentário.' : 'Added a comment.')
    }
  })
  test('subtask targets and status values are translated, unknown ids are omitted', () => {
    const comment = event({ detail: 'on subtask "Revisar Uso"' })
    expect(activitySentence(comment, 'pt')).toBe('Comentou na subtarefa “Revisar Uso”.')
    expect(activitySentence(comment, 'en')).toBe('Commented on subtask “Revisar Uso”.')
    expect(activitySentence(event({ kind: 'status', to: 'in_review' }), 'pt')).toContain('Em revisão')
    expect(activitySentence(event({ kind: 'status', to: 'custom' }), 'en', [{ id: 'custom', label: 'Ready for QA' }])).toContain('Ready for QA')
    expect(activitySentence(event({ kind: 'status', to: 's-12345678' }), 'pt')).toBe('Alterou o status da tarefa.')
    expect(activitySentence(event({ kind: 'internal_new_event', detail: '{"id":"s-12345678"}' }), 'en')).toBe('Updated the task.')
  })
  test('machine actors have consistent readable names', () => {
    for (const lang of ['pt', 'en'] as const) {
      expect(activityActor('session:688c52cc', lang)).toBe(lang === 'pt' ? 'Sessão' : 'Session')
      expect(activityActor('688c52ccaa', lang)).toBe(lang === 'pt' ? 'Sessão' : 'Session')
      expect(activityActor('claude:6df955de67', lang)).toBe('Claude Code')
      expect(activityActor('Maria', lang)).toBe('Maria')
    }
  })
  test('cards link task titles, keep fields together, and never show raw payloads or ids', () => {
    const events = [handback, event({ id: 'session', kind: 'session', actor: 'claude:6df955de67', to: 'f7a2961299', detail: 'claude' }),
      event({ id: 'subtask', detail: 'on subtask "Revisar Uso"' })]
    for (const lang of ['pt', 'en'] as const) for (const isMobile of [false, true]) {
      const html = renderToStaticMarkup(<MemoryRouter><TaskActivityList events={events}
        titles={new Map([['t-3d092f5797', 'Melhorar navegação']])} lang={lang} isMobile={isMobile} /></MemoryRouter>)
      expect(html.match(/>Melhorar navegação<\/a>/g)?.length).toBe(3)
      expect(html).toContain('href="/tasks/t-3d092f5797"')
      expect(html).not.toContain('>t-3d092f5797<')
      for (const raw of ['{&quot;message', '6df955de67', '688c52cc', 'f7a2961299', '>comment<', '>session<']) expect(html).not.toContain(raw)
      expect(html).toContain(lang === 'pt' ? 'Enviou trabalho para revisão.' : 'Sent work for review.')
      expect(html).toContain(lang === 'pt' ? 'Vinculou uma sessão à tarefa.' : 'Linked a session to the task.')
      if (lang === 'pt') expect(html).not.toContain('on subtask')
      expect(html).toContain('text-align:left')
      expect(html).not.toContain(lang === 'pt' ? '>Atividade<' : '>Activity<')
      expect(html).not.toContain(lang === 'pt' ? '>Quando<' : '>When<')
      expect(html).toContain('<time ')
      expect(html).toContain(new Date(handback.at).toLocaleString(lang === 'pt' ? 'pt-BR' : 'en-US'))
      expect(html).not.toContain('text-overflow:ellipsis')
      if (isMobile) expect(html).toContain('min-height:44px')
    }
  })
  test('missing task metadata uses an availability sentence, never the task id', () => {
    const html = renderToStaticMarkup(<MemoryRouter><TaskActivityList events={[event()]} titles={new Map()} lang="pt" /></MemoryRouter>)
    expect(html).toContain('>Tarefa indisponível</a>')
    expect(html).not.toContain('>t-3d092f5797<')
  })
})

test('task detail chips and settings navigation keep physical mobile touch targets', () => {
  const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8')
  const rule = css.slice(css.indexOf('.ag-task-detail :is(button'))
  expect(rule).toContain('min-width: 44px !important')
  expect(rule).toContain('min-height: 44px !important')
  expect(rule).toContain('--ag-tap-grow: 0')
  expect(readFileSync(new URL('./TasksPage.tsx', import.meta.url), 'utf8')).toContain('className="ag-task-detail"')
  const settings = readFileSync(new URL('./settings/SettingsPage.tsx', import.meta.url), 'utf8')
  expect(settings).toContain('minHeight: isMobile ? 44 : undefined,')
})
