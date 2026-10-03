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

  useEffect(() => {
    if (!p.isActive) return
    let alive = true
    void p.host.homeTasks?.().then(r => { if (alive) setData(r) }).catch(() => {})
    return () => { alive = false }
  }, [p.isActive, p.nonce, p.host])

  const tasks = data && 'tasks' in data ? data.tasks : []
  const rows = useMemo(() => taskRows(tasks), [tasks])

  useEffect(() => {
    if (!p.isActive) return
    p.onChrome({ capture: false, claimKeys: ['w'], hints: [t.tasksHints.move, t.tasksHints.web] })
  }, [p.isActive, p.lang])

  useInput((input, key) => {
    if (key.upArrow) setSel(s => Math.max(0, s - 1))
    else if (key.downArrow) setSel(s => Math.min(Math.max(0, tasks.length - 1), s + 1))
    else if (input === 'w') {
      const task = tasks[sel]
      if (!task) return
      if (!p.host.openUrl) { p.onSay({ ok: false, message: p.lang === 'pt' ? 'Este host não abre o navegador.' : 'This host cannot open a browser.' }); return }
      const web = p.status?.services?.find(sv => sv.id === 'agentistics')?.active?.webUrl
      if (!web) { p.onSay({ ok: false, message: p.lang === 'pt' ? 'O servidor agentistics não está rodando — inicie em serviços para abrir a tarefa na web.' : 'The agentistics server is not running — start it in services to open the task on the web.' }); return }
      void p.host.openUrl(`${web.replace(/\/$/, '')}/tasks/${encodeURIComponent(task.id)}`).then(r => p.onSay(r))
    }
  }, { isActive: p.isActive })

  const w = p.width
  const inner = w - 4
  const sub = `${t.tasksSub(tasks.length)}`
  const body: React.ReactNode[] = []
  if (!data) body.push(<Text key="l" color={COLORS.muted}>{t.todayLoading}</Text>)
  else if ('unavailable' in data) body.push(<Text key="u" color={COLORS.muted}>{data.unavailable}</Text>)
  else if (tasks.length === 0) body.push(<Text key="e" color={COLORS.muted}>{t.tasksEmpty}</Text>)
  else {
    // Keep the selection on screen: a window of rows around it.
    const budget = Math.max(1, p.height - 5)
    const selRow = rows.findIndex(r => r.kind === 'task' && r.index === sel)
    const start = Math.max(0, Math.min(selRow - Math.floor(budget / 2), rows.length - budget))
    for (const r of rows.slice(start, start + budget)) {
      if (r.kind === 'head') { body.push(<Text key={`h${r.label}`} color={COLORS.label} bold>{fit(`${r.label} · ${r.count}`, inner)}</Text>); continue }
      const g = statusGlyph(r.task.status)
      const right = `${r.task.progress ? `${r.task.progress.done}/${r.task.progress.total}  ` : ''}${r.task.cost ?? ''}`
      const leftRoom = inner - right.length - 1
      const left = `${r.index === sel ? '❯' : ' '} ${g.glyph} ${r.task.ref} ${r.task.title}`
      body.push(
        <Text key={r.task.id} color={r.task.closed ? COLORS.muted : r.index === sel ? COLORS.text : undefined} dimColor={r.task.closed} bold={r.index === sel}>
          <Text color={r.task.closed ? COLORS.muted : TONE[g.tone]}>{fit(left, Math.max(1, leftRoom))}</Text>
          {` ${right}`}
        </Text>,
      )
    }
  }
  return (
    <Box flexDirection="column" width={w} height={p.height}>
      <Box justifyContent="space-between" width={w} paddingX={1}>
        <Text><Text color={COLORS.label}>{t.tasksTitle} </Text><Text>{fit(sub, Math.max(1, w - 4 - t.tasksTitle.length - (w - 2 >= t.tasksTitle.length + sub.length + t.tasksReadOnly.length + 3 ? t.tasksReadOnly.length + 2 : 0))).trimEnd()}</Text></Text>
        {w - 2 >= t.tasksTitle.length + sub.length + t.tasksReadOnly.length + 3 && <Text color={COLORS.muted}>{t.tasksReadOnly}</Text>}
      </Box>
      <Pane title={t.tasksTitle} width={w} height={p.height - 1} focused={p.isActive}>
        {body}
      </Pane>
    </Box>
  )
}
