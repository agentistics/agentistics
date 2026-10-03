/**
 * Home — the control center's front door (HM-01…HM-07, GL-01): bare `agentop` opens here.
 *
 * The icon (from the real SVG, scaled only) beside the wordmark; the first-prompt box (enter opens
 * the `code` tab's wizard at the TASK step with the prompt carried — every session is filed); and the
 * cards: today (cost api-equivalent, all 4 token counters, sessions, streak, 14-day spark), resume
 * (1-3), your tasks, providers; then one line for the rest of the machine's fleet. At < 100 columns
 * the compact layout keeps two cards (resume, your tasks), as the prototype does.
 *
 * Data, all already on this process: the fleet (the shell's poll), the dashboard's `/api/data` (the
 * same source as the `dashboard` tab — when the server is down the card says so, never zeros), and
 * the host's `homeTasks` / `homeProviders`. The screen decides nothing about a session: 1-3 asks the
 * host exactly what the `sessions` tab asks.
 */
import React, { useEffect, useMemo, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import type { CodeLaunch } from '../code-types'
import type { ActionResult, ControlExit, ControlHost, ControlSession, ControlSessions, ControlStatus, TabId } from '../types'
import type { CliLang } from '../lang'
import type { TabChrome } from '../ControlCenter'
import { Pane } from '../Pane'
import { COLORS } from '../../theme'
import { logoArt } from '../../components/logo-art'
import { LOGO_SVG } from '../../components/logo-svg'
import { WORDMARK_ART } from '../../components/Wordmark'
import { sparkline } from '../../components/Sparkline'
import { useAppData } from '../../data/useAppData'
import { dashboardSource } from '../../dashboard/view'
import {
  compactTokens, homeLayout, money, providerTone, resumeRows, statusGlyph, todayFigures,
  type HomeProvider, type HomeTask,
} from '../home'
import { homeStrings } from '../home-i18n'

export interface HomeProps {
  host: ControlHost
  status: ControlStatus | null
  fleet: ControlSessions | null
  lang: CliLang
  width: number
  height: number
  isActive: boolean
  nonce: number
  onChrome: (chrome: TabChrome) => void
  onSay: (result: ActionResult) => void
  onTab: (step: 1 | -1) => void
  onGoto: (tab: TabId) => void
  /** Open the `code` tab with this launch (the wizard with a prompt, or a session to resume). */
  onOpenCode: (launch: CodeLaunch) => void
  onExit: (exit: ControlExit) => void
  onHelp?: () => void
  /** GL-03: `ctrl+p` opens the shell's command palette. */
  onPalette?: () => void
}

/** `left` and `right` on one line of exactly `w` cells (left truncated first, with an ellipsis). */
function lr(left: string, right: string, w: number): string {
  const room = w - right.length - 1
  if (room < 1) return right.slice(0, w)
  const l = left.length > room ? `${left.slice(0, Math.max(0, room - 1))}…` : left
  return `${l}${' '.repeat(Math.max(1, w - l.length - right.length))}${right}`
}

const fit = (s: string, w: number) => (s.length > w ? `${s.slice(0, Math.max(0, w - 1))}…` : s.padEnd(w))

/** A sentence over several lines of `w` (a card's state in words is never cut mid-sentence). */
function wrapWords(text: string, w: number): string[] {
  const out: string[] = []
  let line = ''
  for (const word of text.split(/\s+/)) {
    if (line && line.length + 1 + word.length > w) { out.push(line); line = word } else line = line ? `${line} ${word}` : word
  }
  if (line) out.push(line)
  return out
}
const said = (text: string, color?: string, w = 0) => wrapWords(text, w).map(l => ({ text: l, ...(color ? { color } : {}) }))

const TONE: Record<string, string> = {
  running: COLORS.running, warn: COLORS.accent, done: COLORS.success, muted: COLORS.muted, danger: COLORS.danger,
}

const STATE_TONE: Partial<Record<ControlSession['state'], string>> = {
  working: COLORS.running, 'waiting-approval': COLORS.accent, waiting: COLORS.accent, closed: COLORS.muted, exited: COLORS.muted,
}

export function Home(p: HomeProps) {
  const t = homeStrings(p.lang)
  const layout = homeLayout(p.width)
  const [prompt, setPrompt] = useState('')
  const [tasks, setTasks] = useState<{ tasks: HomeTask[] } | { unavailable: string } | null>(null)
  const [providers, setProviders] = useState<{ providers: HomeProvider[] } | { unavailable: string } | null>(null)

  const source = useMemo(() => dashboardSource(p.status?.services), [p.status?.services])
  const { data } = useAppData(source.kind === 'api' ? source.apiBase : null, { enabled: p.isActive, nonce: p.nonce })
  const fleetRows = p.fleet?.sessions ?? []

  useEffect(() => {
    if (!p.isActive) return
    let alive = true
    void p.host.homeTasks?.().then(r => { if (alive) setTasks(r) }).catch(() => {})
    void p.host.homeProviders?.().then(r => { if (alive) setProviders(r) }).catch(() => {})
    return () => { alive = false }
  }, [p.isActive, p.nonce, p.host])

  const resume = useMemo(() => resumeRows(fleetRows, Date.now()), [fleetRows])
  const today = useMemo(() => (data ? todayFigures(data.sessions ?? [], fleetRows, new Date()) : null), [data, fleetRows])

  // The footer names only keys that work here (GL-05), most important first.
  useEffect(() => {
    if (!p.isActive) return
    p.onChrome({
      capture: true,
      hints: [t.hints.start, ...(resume.length > 0 ? [t.hints.resume] : []), t.hints.nextTab, t.hints.sessions, 'ctrl+p commands', '? help'],
    })
  }, [p.isActive, resume.length, p.lang])

  function openResume(n: number) {
    const row = resume[n - 1]
    if (!row) { p.onSay({ ok: false, message: t.noResume(n) }); return }
    if (row.native) { p.onOpenCode({ resume: row.id }); return }
    const f = fleetRows.find(x => x.id === row.id)
    if (!f) return
    if (f.state === 'closed' && f.resume && p.host.resumeSession) {
      const resumeSession = p.host.resumeSession
      void (async () => {
        const r = await resumeSession.call(p.host, { sessionId: f.resume!.sessionId, harness: f.harness, cwd: f.cwd, label: f.title, replaces: f.id, attach: true })
        p.onSay({ ok: r.ok, message: r.message })
        if (r.ticket) p.onExit({ kind: 'attach', ticket: r.ticket })
      })()
      return
    }
    const attach = p.host.attachSession
    if (!attach || !f.attached && f.state === 'unknown') { p.onSay({ ok: false, message: t.externalRefuse }); return }
    p.onSay({ ok: true, message: t.openingSession(row.title) })
    void (async () => {
      const ticket = await attach.call(p.host, f.id)
      if (ticket) p.onExit({ kind: 'attach', ticket })
    })()
  }

  useInput((input, key) => {
    if (key.return) {
      if (!p.host.code) { p.onSay({ ok: false, message: t.noCodeTab }); return }
      const text = prompt.trim()
      setPrompt('')
      p.onOpenCode(text ? { prompt: text } : {})
      return
    }
    if (key.ctrl && input === 's') { p.onGoto('sessions'); return }
    if (key.ctrl && input === 'p') { p.onPalette?.(); return }
    if (key.backspace || key.delete) { setPrompt(v => v.slice(0, -1)); return }
    if (key.escape) { setPrompt(''); return }
    if (prompt === '') {
      if (input === ']') { p.onTab(1); return }
      if (input === '[') { p.onTab(-1); return }
      if (input === '?') { p.onHelp?.(); return }
      if (/^[1-3]$/.test(input)) { openResume(Number(input)); return }
    }
    if (input && !key.ctrl && !key.meta && !key.tab && !key.upArrow && !key.downArrow && !key.leftArrow && !key.rightArrow) {
      setPrompt(v => v + input.replace(/[\r\n]/g, ' '))
    }
  }, { isActive: p.isActive })

  // ── layout ──
  const logoRows = Math.max(6, Math.min(11, p.height - 16))
  const logoCols = logoRows * 2
  const logo = useMemo(() => logoArt(LOGO_SVG, logoCols, logoRows), [logoCols, logoRows])
  const infoW = Math.max(10, p.width - logoCols - (layout.narrow ? 3 : 12))
  const info = [
    '',
    ...(infoW >= WORDMARK_ART[0]!.length ? WORDMARK_ART : ['agentistics']),
    '',
    t.harnessLine,
    t.noSandbox,
    t.filedRule,
  ]
  const cw = layout.cardWidth
  const iw = cw - 4
  const cardH = 9

  const todayLines: { text: string; color?: string }[] = today
    ? [
      { text: lr(t.cost, money(today.costUSD), iw) },
      { text: lr(`${t.tokens} ${t.allFour}`, compactTokens(today.tokens), iw) },
      { text: lr(t.sessions, `${today.sessions} · ${today.live} ${t.live}`, iw) },
      { text: lr(t.streak, t.days(today.streak), iw) },
      { text: lr('14d', sparkline(today.spark), iw), color: COLORS.accent },
      { text: fit(t.apiEquivalent, iw), color: COLORS.muted },
    ]
    : said(source.kind === 'down' ? t.todayDown : t.todayLoading, COLORS.muted, iw)

  const resumeLines: { text: string; color?: string }[] = resume.length === 0
    ? [{ text: t.resumeEmpty, color: COLORS.muted }]
    : resume.flatMap((r, i) => [
      { text: lr(`${i + 1} ${r.title}`, r.cost ?? '', iw) },
      { text: fit(`  ${[r.task, r.age].filter(Boolean).join(' · ')} ${r.stateLabel}`, iw), color: STATE_TONE[r.state] ?? COLORS.muted },
    ])

  const taskLines: { text: string; color?: string }[] = !tasks
    ? [{ text: t.todayLoading, color: COLORS.muted }]
    : 'unavailable' in tasks
      ? said(tasks.unavailable, COLORS.muted, iw)
      : tasks.tasks.filter(k => !k.closed).length === 0
        ? said(t.tasksEmpty, COLORS.muted, iw)
        : [
          ...tasks.tasks.filter(k => !k.closed).slice(0, 5).map(k => {
            const g = statusGlyph(k.status)
            return { text: lr(`${g.glyph} ${k.ref} ${k.title}`, k.progress ? `${k.progress.done}/${k.progress.total}` : '', iw), color: TONE[g.tone] }
          }),
          { text: fit(t.tasksDetail, iw), color: COLORS.muted },
        ]

  const providerLines: { text: string; color?: string }[] = !providers
    ? [{ text: t.todayLoading, color: COLORS.muted }]
    : 'unavailable' in providers
      ? said(providers.unavailable, COLORS.muted, iw)
      : [
        ...providers.providers.slice(0, 5).map(v => ({
          text: lr(`● ${v.label}`, v.state === 'ready' ? (v.source ?? t.providerState.ready) : t.providerState[v.state], iw),
          color: TONE[providerTone(v.state)],
        })),
        { text: lr('ctrl+,', t.providersManage, iw), color: COLORS.muted },
      ]

  const cards: Record<string, { title: string; lines: { text: string; color?: string }[] }> = {
    today: { title: t.today, lines: todayLines },
    resume: { title: t.resume, lines: resumeLines },
    tasks: { title: t.yourTasks, lines: taskLines },
    providers: { title: t.providers, lines: providerLines },
  }

  const need = p.fleet?.attention ?? 0
  const others = fleetRows.filter(f => f.state !== 'closed').length
  const promptW = layout.promptWidth
  const promptInner = promptW - 4

  return (
    <Box flexDirection="column" width={p.width} height={p.height}>
      <Box flexDirection="row" marginLeft={layout.narrow ? 1 : 6}>
        <Box flexDirection="column" width={logoCols + 2} flexShrink={0}>
          {logo.map((l, i) => <Text key={i} color={COLORS.accent}>{l}</Text>)}
        </Box>
        <Box flexDirection="column" width={infoW}>
          {info.map((l, i) => (
            <Text key={i} color={i <= WORDMARK_ART.length ? COLORS.accent : i === info.length - 2 ? COLORS.accent : i === info.length - 3 ? COLORS.text : COLORS.muted} bold={i === info.length - 3}>
              {fit(l, infoW)}
            </Text>
          ))}
        </Box>
      </Box>
      <Box marginLeft={Math.max(0, Math.floor((p.width - promptW) / 2))} marginTop={1}>
        <Box borderStyle="round" borderColor={p.isActive ? COLORS.accent : COLORS.border} width={promptW} height={3} paddingX={1}>
          <Text>
            <Text color={COLORS.text}>› </Text>
            {prompt
              ? <Text color={COLORS.text}>{fit(prompt, Math.max(1, promptInner - t.promptHint.length - 4))}</Text>
              : <Text color={COLORS.muted}>{fit(t.promptPlaceholder, Math.max(1, promptInner - t.promptHint.length - 4))}</Text>}
            <Text color={COLORS.muted}>{` ${t.promptHint}`}</Text>
          </Text>
        </Box>
      </Box>
      <Box flexDirection="row" marginTop={1} marginLeft={1}>
        {layout.cards.map((id, i) => (
          <Box key={id} marginLeft={i === 0 ? 0 : 1}>
            <Pane title={cards[id]!.title} width={cw} height={cardH}>
              {cards[id]!.lines.slice(0, cardH - 2).map((l, j) => <Text key={j} color={l.color}>{fit(l.text, iw)}</Text>)}
            </Pane>
          </Box>
        ))}
      </Box>
      <Box marginTop={1} marginLeft={2}>
        <Text>
          <Text color={COLORS.muted}>{p.lang === 'pt' ? 'esta máquina: ' : 'this machine: '}</Text>
          <Text>{t.machine(others, need)}</Text>
          <Text color={COLORS.muted}> · </Text>
          <Text color={need > 0 ? COLORS.accent : COLORS.muted}>{p.lang === 'pt' ? `${need} precisam de você` : `${need} need you`}</Text>
          <Text color={COLORS.muted}>{` · ${t.machineKey}`}</Text>
        </Text>
      </Box>
    </Box>
  )
}
