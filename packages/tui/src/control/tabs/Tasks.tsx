/**
 * Tasks — your tasks, read-only (TK-01, D-TUI-5): grouped by status in the board's own vocabulary
 * and order, each with its progress (only when it has subtasks) and its rollup cost; closed tasks
 * dimmed. Editing stays on the web — `w` opens the selected task there. The data is the host's
 * `homeTasks` (the same read the home card uses), so the two can never disagree.
 */
import React, { useEffect, useMemo, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import type { ActionResult, ControlHost, ControlStatus } from '../types'
import type { CliLang } from '../lang'
import type { TabChrome } from '../ControlCenter'
import { Pane } from '../Pane'
import { COLORS } from '../../theme'
import { statusGlyph, type HomeTask } from '../home'
import { homeStrings } from '../home-i18n'
import { liveSessionOf, taskDetailLines, type TaskDetailView, type TaskLine } from '../task-detail'
import { narrowTerminal } from '../chrome.ts'

export interface TasksProps {
  host: ControlHost
  status: ControlStatus | null
  lang: CliLang
  width: number
  height: number
  isActive: boolean
  nonce: number
  onChrome: (chrome: TabChrome) => void
  onSay: (result: ActionResult) => void
  /** TK-04 / TK-06: open the code tab — a native session resumed, or the wizard with the task chosen. */
  onOpenCode?: (launch: { resume?: string; taskId?: string }) => void
  /** TK-04: a live non-native session — select it in the sessions tab. */
  onFocusSession?: (id: string) => void
}

const TONE: Record<string, string> = { running: COLORS.running, warn: COLORS.accent, done: COLORS.success, muted: COLORS.muted }
const fit = (s: string, w: number) => (s.length > w ? `${s.slice(0, Math.max(0, w - 1))}…` : s.padEnd(w))

/** PURE: the rows to draw — a heading per status (in first-seen order, which is the board's), then its tasks. */
export function taskRows(tasks: readonly HomeTask[]): ({ kind: 'head'; label: string; count: number } | { kind: 'task'; task: HomeTask; index: number })[] {
  const order: string[] = []
  const by = new Map<string, HomeTask[]>()
  for (const t of tasks) {
    if (!by.has(t.status)) { by.set(t.status, []); order.push(t.status) }
    by.get(t.status)!.push(t)
  }
  const out: ReturnType<typeof taskRows> = []
  let index = 0
  for (const st of order) {
    const list = by.get(st)!
    out.push({ kind: 'head', label: list[0]!.statusLabel, count: list.length })
    for (const task of list) out.push({ kind: 'task', task, index: index++ })
  }
  return out
}

export function Tasks(p: TasksProps) {
  const t = homeStrings(p.lang)
  const [data, setData] = useState<{ tasks: HomeTask[] } | { unavailable: string } | null>(null)
  const [sel, setSel] = useState(0)
  const [detail, setDetail] = useState<TaskDetailView | { unavailable: string } | null>(null)
  const [pane, setPane] = useState<'list' | 'detail'>('list')
  const [scroll, setScroll] = useState(0)

  useEffect(() => {
    if (!p.isActive) return
    let alive = true
    void p.host.homeTasks?.().then(r => { if (alive) setData(r) }).catch(() => {})
    return () => { alive = false }
  }, [p.isActive, p.nonce, p.host])

  const tasks = data && 'tasks' in data ? data.tasks : []
  const rows = useMemo(() => taskRows(tasks), [tasks])
  const current = tasks[sel]

  // The detail follows the selection (and the refresh nonce).
  useEffect(() => {
    if (!p.isActive || !current || !p.host.taskDetail) return
    let alive = true
    setScroll(0)
    void p.host.taskDetail(current.id).then(r => { if (alive) setDetail(r) }).catch(() => {})
    return () => { alive = false }
  }, [p.isActive, p.nonce, p.host, current?.id])

  const narrow = narrowTerminal(p.width)
  const view = detail && 'id' in detail && detail.id === current?.id ? detail : null
  const webUrl = p.status?.services?.find(sv => sv.id === 'agentistics')?.active?.webUrl ?? null

  useEffect(() => {
    if (!p.isActive) return
    p.onChrome({
      capture: false, claimKeys: ['w', 'n'], claimArrows: true,
      hints: [t.tasksHints.move, ...(narrow ? [t.tasksHints.pane] : []), t.tasksHints.open, t.tasksHints.new, t.tasksHints.web],
    })
  }, [p.isActive, p.lang, narrow])

  const say = (ok: boolean, message: string) => p.onSay({ ok, message })

  useInput((input, key) => {
    if (narrow && key.tab) { setPane(x => (x === 'list' ? 'detail' : 'list')); return }
    if (narrow && pane === 'detail' && key.escape) { setPane('list'); return }
    if (narrow && pane === 'detail' && (key.upArrow || key.downArrow)) { setScroll(x => Math.max(0, x + (key.upArrow ? -1 : 1))); return }
    if (key.upArrow) setSel(s => Math.max(0, s - 1))
    else if (key.downArrow) setSel(s => Math.min(Math.max(0, tasks.length - 1), s + 1))
    else if (key.return) {
      // TK-04: the live session of the task — native opens in the code tab, others are selected in
      // sessions (where enter attaches). None live: said, with the way to start one.
      if (!current) return
      if (!view) { say(false, t.detailLoading); return }
      const live = liveSessionOf(view)
      if (!live) { say(false, t.noLive(current.ref)); return }
      if (live.harness === 'agentistics' && p.onOpenCode) { p.onOpenCode({ resume: live.id }); return }
      if (p.onFocusSession) { p.onFocusSession(live.id); say(true, t.liveElsewhere(live.title)); return }
    } else if (input === 'n') {
      // TK-06: the wizard with this task chosen; refused in words on a closed task or with no harness.
      if (!current) return
      if (current.closed) { say(false, t.doneNoNew(current.ref)); return }
      if (!p.host.code || !p.onOpenCode) { say(false, p.host.nativeGate?.() ?? t.noCodeTab); return }
      p.onOpenCode({ taskId: current.id })
    } else if (input === 'w') {
      const task = tasks[sel]
      if (!task) return
      if (!p.host.openUrl) { say(false, p.lang === 'pt' ? 'Este host não abre o navegador.' : 'This host cannot open a browser.'); return }
      if (!webUrl) { say(false, p.lang === 'pt' ? 'O servidor agentistics não está rodando — inicie em serviços para abrir a tarefa na web.' : 'The agentistics server is not running — start it in services to open the task on the web.'); return }
      void p.host.openUrl(`${webUrl.replace(/\/$/, '')}/tasks/${encodeURIComponent(task.id)}`).then(r => p.onSay(r))
    }
  }, { isActive: p.isActive })

  const w = p.width
  const listW = narrow ? w : Math.min(54, Math.floor(w / 2))
  const detailW = narrow ? w : w - listW
  const paneH = p.height - (narrow ? 2 : 1)
  const sub = `${t.tasksSub(tasks.length)}`

  const listBody = (inner: number): React.ReactNode[] => {
    const out: React.ReactNode[] = []
    if (!data) out.push(<Text key="l" color={COLORS.muted}>{t.todayLoading}</Text>)
    else if ('unavailable' in data) out.push(<Text key="u" color={COLORS.muted}>{data.unavailable}</Text>)
    else if (tasks.length === 0) out.push(<Text key="e" color={COLORS.muted}>{t.tasksEmpty}</Text>)
    else {
      const budget = Math.max(1, paneH - 2)
      const selRow = rows.findIndex(r => r.kind === 'task' && r.index === sel)
      const start = Math.max(0, Math.min(selRow - Math.floor(budget / 2), rows.length - budget))
      for (const r of rows.slice(start, start + budget)) {
        if (r.kind === 'head') { out.push(<Text key={`h${r.label}`} color={COLORS.label} bold>{fit(`${r.label} · ${r.count}`, inner)}</Text>); continue }
        const g = statusGlyph(r.task.status)
        const right = `${r.task.progress ? `${r.task.progress.done}/${r.task.progress.total}  ` : ''}${r.task.cost ?? ''}`
        const leftRoom = inner - right.length - 1
        const left = `${r.index === sel ? '❯' : ' '} ${g.glyph} ${r.task.ref} ${r.task.title}`
        out.push(
          <Text key={r.task.id} color={r.task.closed ? COLORS.muted : r.index === sel ? COLORS.text : undefined} dimColor={r.task.closed} bold={r.index === sel}>
            <Text color={r.task.closed ? COLORS.muted : TONE[g.tone]}>{fit(left, Math.max(1, leftRoom))}</Text>
            {` ${right}`}
          </Text>,
        )
      }
    }
    return out
  }

  const detailBody = (inner: number): React.ReactNode[] => {
    if (!current) return []
    if (detail && 'unavailable' in detail) return [<Text key="u" color={COLORS.muted}>{detail.unavailable}</Text>]
    if (!view) return [<Text key="l" color={COLORS.muted}>{t.detailLoading}</Text>]
    const lines = taskDetailLines(view, t.detail, webUrl)
    const drawn = lines.flatMap((l, i) => renderLine(l, i, inner))
    const room = Math.max(1, paneH - 2)
    const top = Math.min(scroll, Math.max(0, drawn.length - room))
    return drawn.slice(top, top + room)
  }

  return (
    <Box flexDirection="column" width={w} height={p.height}>
      <Box justifyContent="space-between" width={w} paddingX={1}>
        <Text><Text color={COLORS.label}>{t.tasksTitle} </Text><Text>{fit(sub, Math.max(1, w - 4 - t.tasksTitle.length - (w - 2 >= t.tasksTitle.length + sub.length + t.tasksReadOnly.length + 3 ? t.tasksReadOnly.length + 2 : 0))).trimEnd()}</Text></Text>
        {w - 2 >= t.tasksTitle.length + sub.length + t.tasksReadOnly.length + 3 && <Text color={COLORS.muted}>{t.tasksReadOnly}</Text>}
      </Box>
      {narrow && <Text color={COLORS.muted}>{`  ${t.narrowStrip.split(' · ').map((x, i) => ((i === 0) === (pane === 'list') ? `[${x}]` : x)).join(' · ')}`}</Text>}
      <Box flexDirection="row" width={w}>
        {(!narrow || pane === 'list') && (
          <Pane title={t.tasksTitle} width={listW} height={paneH} focused={p.isActive && (!narrow || pane === 'list')}>
            {listBody(listW - 4)}
          </Pane>
        )}
        {(!narrow || pane === 'detail') && (
          <Pane title={current ? `${t.detailTitle} ${current.ref}` : t.detailTitle} width={detailW} height={paneH} focused={p.isActive && narrow && pane === 'detail'}>
            {detailBody(detailW - 4)}
          </Pane>
        )}
      </Box>
    </Box>
  )
}

const STATE_TONE: Record<string, string> = {
  'waiting-approval': COLORS.danger, waiting: COLORS.accent, working: COLORS.running,
}

/** One detail line, drawn; long notes wrap rather than being cut mid-word. */
function renderLine(l: TaskLine, i: number, inner: number): React.ReactNode[] {
  const k = `d${i}`
  const lr = (left: string, right: string, w = inner) => {
    const room = Math.max(1, w - right.length - 1)
    return `${fit(left, room)} ${right}`
  }
  switch (l.kind) {
    case 'blank': return [<Text key={k}> </Text>]
    case 'title': return wrapWords(l.text, inner).map((x, j) => <Text key={`${k}.${j}`} bold color={COLORS.text}>{x}</Text>)
    case 'meta': {
      const g = statusGlyph(l.statusId)
      return [<Text key={k} wrap="truncate"><Text color={TONE[g.tone]}>{`${g.glyph} ${l.status}`}</Text><Text color={COLORS.muted}>{l.rest ? `  ·  ${l.rest}` : ''}</Text></Text>]
    }
    case 'blocked': return wrapWords(l.text, inner).map((x, j) => <Text key={`${k}.${j}`} color={COLORS.danger}>{x}</Text>)
    case 'progress': {
      const barW = Math.max(4, Math.min(24, inner - l.text.length - 2))
      const on = Math.round((l.done / l.total) * barW)
      return [<Text key={k} wrap="truncate"><Text color={COLORS.running}>{'█'.repeat(on)}</Text><Text color={COLORS.muted}>{'░'.repeat(barW - on)}</Text>{` ${l.text}`}</Text>]
    }
    case 'note': return wrapWords(l.text, inner).map((x, j) => <Text key={`${k}.${j}`} color={COLORS.muted}>{x}</Text>)
    case 'rollup':
      // The figures and where they come from on one line when they fit, otherwise two — never cut.
      return l.text.length + l.right.length + 2 <= inner
        ? [<Text key={k} wrap="truncate" color={l.na ? COLORS.muted : undefined}>{lr(l.text, l.right)}</Text>]
        : [<Text key={k} wrap="truncate" color={l.na ? COLORS.muted : undefined}>{l.text}</Text>, <Text key={`${k}.r`} color={COLORS.muted}>{l.right}</Text>]
    case 'head': return [<Text key={k} color={COLORS.label} bold>{l.text}</Text>]
    case 'subtask': return [<Text key={k} wrap="truncate"><Text color={l.done ? COLORS.success : COLORS.muted}>{l.done ? '✓ ' : '○ '}</Text>{lr(l.title, l.right, inner - 2)}</Text>]
    case 'session': {
      const s = l.session
      const dot = s.state === 'closed' || s.state === 'exited' || s.state === 'lost' ? '○' : s.state === 'unknown' ? '◌' : '●'
      return [<Text key={k} wrap="truncate"><Text color={STATE_TONE[s.state] ?? COLORS.muted}>{`${dot} `}</Text>{lr(`${s.title}  ${s.harness}`, l.right, inner - 2)}</Text>]
    }
    case 'web': return wrapWords(l.text, inner).map((x, j) => <Text key={`${k}.${j}`} color={COLORS.info}>{x}</Text>)
  }
}

function wrapWords(text: string, w: number): string[] {
  const out: string[] = []
  let line = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (!line) line = word
    else if (line.length + 1 + word.length <= w) line += ` ${word}`
    else { out.push(line); line = word }
  }
  if (line) out.push(line)
  return out.length ? out : ['']
}
