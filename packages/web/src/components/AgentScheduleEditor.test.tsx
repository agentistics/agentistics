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
  const html = renderToStaticMarkup(<AgentScheduleEditor draft={sched} onChange={() => {}} who="Claude Code · Vini" lang="pt"
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
  test('English', () => {
    const en = renderToStaticMarkup(<AgentScheduleEditor draft={sched} onChange={() => {}} who="x" lang="en" />)
    expect(en).toContain('Stop agents when the week reaches')
    expect(en).toContain('Mon')
  })
})

describe('the popup draws only the switch and "Sign in again"', () => {
  const html = renderToStaticMarkup(<PlanUsageSummary limits={[limits]} now={NOW} lang="pt"
    agentUse={() => ({ on: false, enabled: false, override: false, pending: false, setEnabled: () => {}, setOverride: () => {}, accountId: 'acc_1', reloginable: true, loginBroken: true })} onRelogin={() => {}} />)
  test('the two switches + re-login per account', () => {
    expect(html).toContain('data-plan-row-controls="acc_1"')
    expect(html).toContain('role="switch"')
    expect(html).toContain('aria-checked="false"')
    expect(html).toContain('Refazer login')
    expect(html.match(/role="switch"/g)?.length).toBe(2)
    expect(html).toContain('Sobrescrever a agenda')
    expect(html).toContain('disabled')  // the override cannot be turned on while the Agenda is off
  })
  test('a signed-out account draws "sem login", not stale 0/0 rings (RELOGIN.NAYARA)', () => {
    expect(html).toContain('sem login')
    expect(html).not.toContain('Semana')
    const en = renderToStaticMarkup(<PlanUsageSummary limits={[limits]} now={NOW} lang="en"
      agentUse={() => ({ on: false, enabled: false, override: false, pending: false, setEnabled: () => {}, setOverride: () => {}, accountId: 'acc_1', reloginable: true, loginBroken: true })} onRelogin={() => {}} />)
    expect(en).toContain('signed out')
    // The same account while its login works keeps its rings.
    const ok = renderToStaticMarkup(<PlanUsageSummary limits={[limits]} now={NOW} lang="pt"
      agentUse={() => ({ on: true, enabled: true, override: false, pending: false, setEnabled: () => {}, setOverride: () => {}, accountId: 'acc_1', reloginable: true, loginBroken: false })} onRelogin={() => {}} />)
    expect(ok).not.toContain('sem login')
    expect(ok).toContain('Semana')
  })
  test('no schedule in the popup', () => {
    expect(html).not.toContain('data-agent-schedule')
    expect(html).not.toContain('data-agent-day')
  })
  test('a working account (login ok) never shows the button, even if it could run it', () => {
    const h = renderToStaticMarkup(<PlanUsageSummary limits={[limits]} now={NOW} lang="pt"
      agentUse={() => ({ on: true, enabled: true, override: false, pending: false, setEnabled: () => {}, setOverride: () => {}, accountId: 'acc_1', reloginable: true, loginBroken: false })} onRelogin={() => {}} />)
    expect(h).not.toContain('Refazer login')
  })
  test('no re-login button when the account cannot run it', () => {
    const h = renderToStaticMarkup(<PlanUsageSummary limits={[limits]} now={NOW} lang="pt"
      agentUse={() => ({ on: true, enabled: true, override: false, pending: false, setEnabled: () => {}, setOverride: () => {}, accountId: 'acc_1', reloginable: false })} onRelogin={() => {}} />)
    expect(h).not.toContain('Refazer login')
  })
})

describe('the plan-usage modal card: the two switches, no schedule editor and no Save of its own', () => {
  test('badge + the two switches + a pointer to Accounts', () => {
    const html = renderToStaticMarkup(<PlanUsageCard limits={limits} now={NOW} lang="pt"
      agentUse={{ on: true, enabled: true, override: false, pending: false, setEnabled: () => {}, setOverride: () => {}, accountId: 'acc_1', schedule: sched, view: { reason: 'override-on', on: true, dayUsedPct: null } }} />)
    expect(html).toContain('data-agent-use-badge="override-on"')
    expect(html).toContain('data-agent-use-switches="inline"')
    expect(html).toContain('Sobrescrever a agenda')
    expect(html).not.toContain('data-agent-schedule-toggle')
    expect(html).not.toContain('data-agent-schedule-save')
    expect(html).toContain('data-agent-schedule-in-account')
  })
})

describe('F2: the popup row shows the off-by-schedule reason', () => {
  const html = renderToStaticMarkup(<PlanUsageSummary limits={[limits]} now={NOW} lang="pt"
    agentUse={() => ({ on: false, enabled: false, override: false, pending: false, setEnabled: () => {}, setOverride: () => {}, accountId: 'acc_1', reloginable: false, view: { reason: 'weekly-cap', on: false, dayUsedPct: null, weekUsedPct: 50, maxWeeklyPct: 50 } })} />)
  test('reason text beside the switch', () => {
    expect(html).toContain('data-agent-use-badge="weekly-cap"')
    expect(html).toContain('Teto da semana atingido')
  })
})

describe('all day + weekly ceiling in the editor', () => {
  const full: AgentSchedule = { enabled: true, maxWeeklyPct: 60, days: { mon: { windows: [{ from: '09:00', to: '18:00' }], allDay: true, maxDailyPct: 20 } } }
  const html = renderToStaticMarkup(<AgentScheduleEditor draft={full} onChange={() => {}} who="x" lang="pt"
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
  test('F1: no "00:00 – 24:00" beside the chip, and the summary says "dia inteiro"', () => {
    expect(html).not.toContain('00:00 – 24:00')
    expect(html).toContain('data-agent-schedule-line')
    expect(html).toContain('seg: dia inteiro')
    expect(html).toContain('aria-pressed="true" data-agent-allday="mon"')
  })
  test('weekly ceiling field above the days, with the live reading', () => {
    expect(html.indexOf('data-agent-weekly-cap')).toBeLessThan(html.indexOf('data-agent-day-editor'))
    expect(html).toContain('Parar os agentes quando a semana chegar a')
    expect(html).toContain('value="60"')
    expect(html).toContain('semana em 30% agora')
  })
})
