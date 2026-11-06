/** No jsdom in this repo: the markup is rendered statically and the edits are pure (agentScheduleView.test.ts). */
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AgentSchedule, PlanLimits } from '@agentistics/core'
import { AgentScheduleEditor } from './AgentScheduleEditor'
import { PlanUsageCard, PlanUsageSummary } from './PlanLimitMeter'

const NOW = Date.parse('2026-11-02T12:00:00Z')
const sched: AgentSchedule = { enabled: true, days: { mon: { windows: [{ from: '09:00', to: '12:00' }, { from: '22:00', to: '02:00' }], maxDailyPct: 20 } } }
const limits: PlanLimits = { harness: 'claude', account: 'acc_1', plan: 'Max 5x', source: 'claude-usage-api', updatedAt: NOW, windows: [{ kind: 'week', usedPct: 30, resetsAt: NOW + 86_400_000 }] }

describe('AgentScheduleEditor', () => {
  const html = renderToStaticMarkup(<AgentScheduleEditor accountId="acc_1" who="Claude Code · Vini" schedule={sched} lang="pt"
    view={{ reason: 'outside-window', on: false, dayUsedPct: 4, maxDailyPct: 20 }} />)
  test('seven day chips, the selected one pressed', () => {
    expect(html.match(/data-agent-day="/g)?.length).toBe(7)
    expect(html).toContain('aria-pressed="true" data-agent-day="mon"')
    expect(html).toContain('aria-pressed="false" data-agent-day="tue"')
  })
  test('windows, the midnight crossing, the ceiling and the copy action of a selected day', () => {
    expect(html.match(/data-agent-window/g)?.length).toBe(2)
    expect(html).toContain('value="22:00"')
    expect(html).toContain('termina no dia seguinte')
    expect(html).toContain('value="20"')
    expect(html).toContain('% da semana')
  })
  test('the state badge with its reason and the day usage', () => {
    expect(html).toContain('data-agent-use-badge="outside-window"')
    expect(html).toContain('hoje: 4% de 20% permitido')
  })
  test('English', () => {
    const en = renderToStaticMarkup(<AgentScheduleEditor accountId="acc_1" who="x" lang="en" />)
    expect(en).toContain('Agent-use schedule')
    expect(en).toContain('Mon')
  })
})

describe('the popup draws only the switch and "Sign in again"', () => {
  const html = renderToStaticMarkup(<PlanUsageSummary limits={[limits]} now={NOW} lang="pt"
    agentUse={() => ({ on: false, pending: false, onToggle: () => {}, accountId: 'acc_1', reloginable: true, loginBroken: true })} onRelogin={() => {}} />)
  test('switch + re-login per account', () => {
    expect(html).toContain('data-plan-row-controls="acc_1"')
    expect(html).toContain('role="switch"')
    expect(html).toContain('aria-checked="false"')
    expect(html).toContain('Refazer login')
  })
  test('no schedule in the popup', () => {
    expect(html).not.toContain('data-agent-schedule')
    expect(html).not.toContain('data-agent-day')
  })
  test('a working account (login ok) never shows the button, even if it could run it', () => {
    const h = renderToStaticMarkup(<PlanUsageSummary limits={[limits]} now={NOW} lang="pt"
      agentUse={() => ({ on: true, pending: false, onToggle: () => {}, accountId: 'acc_1', reloginable: true, loginBroken: false })} onRelogin={() => {}} />)
    expect(h).not.toContain('Refazer login')
  })
  test('no re-login button when the account cannot run it', () => {
    const h = renderToStaticMarkup(<PlanUsageSummary limits={[limits]} now={NOW} lang="pt"
      agentUse={() => ({ on: true, pending: false, onToggle: () => {}, accountId: 'acc_1', reloginable: false })} onRelogin={() => {}} />)
    expect(h).not.toContain('Refazer login')
  })
})

describe('the plan-usage modal card offers the schedule', () => {
  test('badge + Agenda disclosure', () => {
    const html = renderToStaticMarkup(<PlanUsageCard limits={limits} now={NOW} lang="pt"
      agentUse={{ on: true, pending: false, onToggle: () => {}, accountId: 'acc_1', schedule: sched, view: { reason: 'manual-on', on: true, dayUsedPct: null } }} />)
    expect(html).toContain('data-agent-use-badge="manual-on"')
    expect(html).toContain('data-agent-schedule-toggle')
    expect(html).toContain('Agenda · ligada')
  })
})

describe('all day + weekly ceiling in the editor', () => {
  const full: AgentSchedule = { enabled: true, maxWeeklyPct: 60, days: { mon: { windows: [{ from: '09:00', to: '18:00' }], allDay: true, maxDailyPct: 20 } } }
  const html = renderToStaticMarkup(<AgentScheduleEditor accountId="acc_1" who="x" schedule={full} lang="pt"
    view={{ reason: 'in-window', on: true, dayUsedPct: 4, weekUsedPct: 30, maxDailyPct: 20, maxWeeklyPct: 60 }} />)
  test('all-day hides the time inputs and the add-window button, keeps the daily ceiling', () => {
    expect(html).toContain('data-agent-allday="mon"')
    expect(html).not.toContain('data-agent-window')
    expect(html).not.toContain('type="time"')
    expect(html).not.toContain('>janela<')
    expect(html).toContain('value="20"')
    expect(html).toContain('Gastar no máximo')
    expect(html).toContain('% da semana neste dia')
  })
  test('weekly ceiling field above the days, with the live reading', () => {
    expect(html.indexOf('data-agent-weekly-cap')).toBeLessThan(html.indexOf('data-agent-day-editor'))
    expect(html).toContain('Parar os agentes quando a semana chegar a')
    expect(html).toContain('value="60"')
    expect(html).toContain('semana em 30% agora')
  })
})
