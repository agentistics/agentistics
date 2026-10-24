/**
 * toolActivity.ts — PURE: a run of tool calls as something a person reads (CHAT.ACTIVITY, PROTOTYPE).
 *
 * Asked for directly (owner, 2026-10-16): in the session chat, a run of tool calls becomes ONE human
 * summary line — "Criando um arquivo, atualizando 3 memórias · 1 min 20 s" — and, opened, the steps
 * one per line: a grey VERB and a highlighted OBJECT ("Memória atualizada · Overview").
 *
 * Every harness, through ONE rule. The kind of a call is read off `canonical ?? name` — the shared
 * vocabulary `canonicalTool` (server, `harness-activity.ts`) already maps every harness onto — plus a
 * small table of each harness's own names that the shared map does not carry yet (codex 0.161's
 * `exec`, copilot's `rg`/`apply_patch`, gemini's `update_topic`/`save_memory`, agy's `search_web`…,
 * all measured on this machine's transcripts on 2026-10-16). A name nothing knows is NOT dropped: it
 * becomes an `other` step that says the tool's own name, the same "a mapping, never a filter" rule.
 *
 * Nothing is lost: a step carries the call's `ref`, which is what the Live feed already opens with
 * `/api/fleet/step` — the expanded card links each row there.
 */

export type ActivityKind =
  | 'read' | 'edit' | 'write' | 'run' | 'search' | 'web' | 'memory'
  | 'delegate' | 'plan' | 'skill' | 'mcp' | 'other'

export type StepStatus = 'running' | 'done' | 'error' | 'unfinished'

/** The fields of a `ChatTurn.tools` entry this module reads (plus the proposed `failed`). */
export interface ToolCallLike {
  name: string
  canonical?: string
  detail?: string
  ref?: string
  /** PROPOSED: the call's `tool_result` reported an error. Not on `ChatTurn` yet — see the options doc. */
  failed?: boolean
}

export interface TurnLike {
  at?: string
  role: 'user' | 'assistant'
  text: string
  pending?: boolean
  tools?: ToolCallLike[]
}

export interface ActivityStep {
  kind: ActivityKind
  /** The harness's own tool name, kept for the tooltip and the raw view. */
  name: string
  /** What the step acted on, short: a file's name, a command's summary, a memory's title. */
  object: string
  /** The whole detail the transcript carried (a path, a command line). */
  detail?: string
  ref?: string
  status: StepStatus
}

export interface ActivityGroup {
  key: string
  steps: ActivityStep[]
  /** ISO of the first turn in the run. */
  startedAt?: string
  /** ISO of the turn that closed the run (the next text or the next person's turn); absent while running. */
  endedAt?: string
  running: boolean
}

// ── kind ────────────────────────────────────────────────────────────────────────────────────────

/** The shared vocabulary (Claude's names, as `canonicalTool` returns them) → kind. */
const CANONICAL_KIND: Record<string, ActivityKind> = {
  Bash: 'run', BashOutput: 'run', KillShell: 'run',
  Read: 'read', NotebookRead: 'read',
  Edit: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit',
  Write: 'write',
  Grep: 'search', Glob: 'search', LS: 'search', ToolSearch: 'search',
  WebFetch: 'web', WebSearch: 'web',
  Agent: 'delegate', Task: 'delegate',
  TodoWrite: 'plan', TaskCreate: 'plan', TaskUpdate: 'plan',
  Skill: 'skill',
}

/**
 * Harness-own names the shared map does not (yet) translate. Measured 2026-10-16: codex 0.161 calls
 * every shell `exec`; copilot `rg`, `apply_patch`, `read_bash`; gemini `glob`, `update_topic`,
 * `save_memory`, `google_web_search`, `web_fetch`; agy `search_web`, `read_url_content`,
 * `invoke_subagent`, `manage_task`. Each of these belongs in `TOOL_ALIASES` when this ships.
 */
const RAW_KIND: Record<string, ActivityKind> = {
  exec: 'run', read_bash: 'run', write_bash: 'run',
  apply_patch: 'edit', str_replace_editor: 'edit',
  rg: 'search', glob: 'search', grep: 'search',
  google_web_search: 'web', web_fetch: 'web', search_web: 'web', read_url_content: 'web',
  save_memory: 'memory',
  invoke_subagent: 'delegate',
  update_plan: 'plan', update_topic: 'plan', manage_task: 'plan',
}

const MCP = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$|^mcp_([a-z0-9-]+)_(.+)$/i

/** Most frequent kind; ties keep first appearance, including unfinished steps. */
export function activityIconKind(steps: readonly ActivityStep[]): ActivityKind {
  const counts = new Map<ActivityKind, number>()
  for (const step of steps) counts.set(step.kind, (counts.get(step.kind) ?? 0) + 1)
  let kind: ActivityKind = 'other'
  let most = 0
  for (const [candidate, count] of counts) {
    if (count > most) { kind = candidate; most = count }
  }
  return kind
}

/** Dominant MCP server, with the same count/first-appearance rule as the kind. */
export function activityMcpServer(steps: readonly ActivityStep[]): string | undefined {
  const counts = new Map<string, number>()
  for (const step of steps) {
    if (step.kind !== 'mcp') continue
    const match = MCP.exec(step.name)
    const server = (match?.[1] ?? match?.[3] ?? '').toLowerCase()
    counts.set(server, (counts.get(server) ?? 0) + 1)
  }
  let server: string | undefined
  let most = 0
  for (const [candidate, count] of counts) {
    if (count > most) { server = candidate || undefined; most = count }
  }
  return server
}

/** A path that is an assistant MEMORY rather than project code (Claude's auto-memory, agentistics leader notes). */
const MEMORY_PATH = /(^|\/)(memory|memories)\/[^/]+\.md$|\/MEMORY\.md$|(^|\/)GEMINI\.md$/

export function kindOf(call: ToolCallLike): ActivityKind {
  const name = call.canonical ?? call.name
  let kind: ActivityKind = CANONICAL_KIND[name] ?? RAW_KIND[call.name] ?? RAW_KIND[name] ?? (MCP.test(call.name) ? 'mcp' : 'other')
  const detail = call.detail?.trim() ?? ''
  // A codex `exec` that is a patch IS an edit: the command is the only place that says so.
  if (kind === 'run' && /^apply_patch\b/.test(detail)) kind = 'edit'
  if ((kind === 'edit' || kind === 'write') && MEMORY_PATH.test(detail)) kind = 'memory'
  return kind
}

// ── object ──────────────────────────────────────────────────────────────────────────────────────

const basename = (p: string) => p.replace(/\/+$/, '').split('/').pop() ?? p

function clip(s: string, max = 72): string {
  const line = s.trim().split('\n')[0]?.trim() ?? ''
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** A memory's display title: its file name without `.md`, dashes as spaces, first letter up. */
function memoryTitle(p: string): string {
  const base = basename(p).replace(/\.md$/i, '').replace(/[-_]+/g, ' ').trim()
  return base ? base[0]!.toUpperCase() + base.slice(1) : p
}

export function objectOf(call: ToolCallLike, kind: ActivityKind): string {
  const d = call.detail?.trim() ?? ''
  switch (kind) {
    case 'read': case 'edit': case 'write': {
      // A patch names its file inside the patch text (`*** Update File: <path>`), not as the first word.
      const patched = [...d.matchAll(/^\*\*\* (?:Update|Add|Delete) File:[ \t]*(.+?)\r?$/gm)]
        .map(match => match[1]!.trim()).filter(Boolean)
      const targets = [...new Set(patched)]
      return targets.length ? targets.map(basename).join(', ') : d ? basename(d.split(/\s+/)[0]!) : call.name
    }
    case 'memory':
      return d ? memoryTitle(d) : call.name
    case 'run': case 'search': case 'web': case 'delegate': case 'plan': case 'skill':
      return d ? clip(d) : call.name
    case 'mcp': {
      const m = MCP.exec(call.name)
      const server = m?.[1] ?? m?.[3] ?? ''
      const tool = m?.[2] ?? m?.[4] ?? call.name
      return server ? `${server} · ${tool}` : tool
    }
    default:
      return d ? `${call.name} · ${clip(d, 48)}` : call.name
  }
}

// ── words ───────────────────────────────────────────────────────────────────────────────────────

type Words = {
  /** step row, while it runs */ doing: [string, string]
  /** step row, once done */ done: [string, string]
  /** summary phrase, running — n=1 */ gerund1: [string, string]
  /** summary phrase, running — n>1, `#` is the count */ gerundN: [string, string]
  /** summary phrase, done — n=1 */ past1: [string, string]
  /** summary phrase, done — n>1 */ pastN: [string, string]
}

/** [pt, en]. Kept in ONE table so a kind cannot gain a verb in one language and not the other. */
export const ACTIVITY_WORDS: Record<ActivityKind, Words> = {
  read:     { doing: ['Lendo', 'Reading'], done: ['Leu', 'Read'],
              gerund1: ['lendo um arquivo', 'reading a file'], gerundN: ['lendo # arquivos', 'reading # files'],
              past1: ['leu um arquivo', 'read a file'], pastN: ['leu # arquivos', 'read # files'] },
  edit:     { doing: ['Editando', 'Editing'], done: ['Editou', 'Edited'],
              gerund1: ['editando um arquivo', 'editing a file'], gerundN: ['editando # arquivos', 'editing # files'],
              past1: ['editou um arquivo', 'edited a file'], pastN: ['editou # arquivos', 'edited # files'] },
  write:    { doing: ['Criando', 'Creating'], done: ['Criou', 'Created'],
              gerund1: ['criando um arquivo', 'creating a file'], gerundN: ['criando # arquivos', 'creating # files'],
              past1: ['criou um arquivo', 'created a file'], pastN: ['criou # arquivos', 'created # files'] },
  run:      { doing: ['Executando', 'Running'], done: ['Executou', 'Ran'],
              gerund1: ['executando um comando', 'running a command'], gerundN: ['executando # comandos', 'running # commands'],
              past1: ['executou um comando', 'ran a command'], pastN: ['executou # comandos', 'ran # commands'] },
  search:   { doing: ['Buscando', 'Searching'], done: ['Buscou', 'Searched'],
              gerund1: ['buscando no código', 'searching the code'], gerundN: ['fazendo # buscas', 'running # searches'],
              past1: ['fez uma busca', 'ran a search'], pastN: ['fez # buscas', 'ran # searches'] },
  web:      { doing: ['Consultando', 'Looking up'], done: ['Consultou', 'Looked up'],
              gerund1: ['consultando a web', 'looking something up'], gerundN: ['consultando # páginas', 'looking up # pages'],
              past1: ['consultou a web', 'looked something up'], pastN: ['consultou # páginas', 'looked up # pages'] },
  memory:   { doing: ['Atualizando memória', 'Updating memory'], done: ['Atualizou memória', 'Memory updated'],
              gerund1: ['atualizando uma memória', 'updating a memory'], gerundN: ['atualizando # memórias', 'updating # memories'],
              past1: ['atualizou uma memória', 'updated a memory'], pastN: ['atualizou # memórias', 'updated # memories'] },
  delegate: { doing: ['Delegando', 'Delegating'], done: ['Delegou', 'Delegated'],
              gerund1: ['delegando uma tarefa', 'delegating a task'], gerundN: ['delegando # tarefas', 'delegating # tasks'],
              past1: ['delegou uma tarefa', 'delegated a task'], pastN: ['delegou # tarefas', 'delegated # tasks'] },
  plan:     { doing: ['Atualizando o plano', 'Updating the plan'], done: ['Atualizou o plano', 'Plan updated'],
              gerund1: ['atualizando o plano', 'updating the plan'], gerundN: ['atualizando o plano', 'updating the plan'],
              past1: ['atualizou o plano', 'updated the plan'], pastN: ['atualizou o plano', 'updated the plan'] },
  skill:    { doing: ['Carregando skill', 'Loading skill'], done: ['Carregou skill', 'Skill loaded'],
              gerund1: ['carregando uma skill', 'loading a skill'], gerundN: ['carregando # skills', 'loading # skills'],
              past1: ['carregou uma skill', 'loaded a skill'], pastN: ['carregou # skills', 'loaded # skills'] },
  mcp:      { doing: ['Usando', 'Using'], done: ['Usou', 'Used'],
              gerund1: ['usando uma ferramenta MCP', 'using an MCP tool'], gerundN: ['usando # ferramentas MCP', 'using # MCP tools'],
              past1: ['usou uma ferramenta MCP', 'used an MCP tool'], pastN: ['usou # ferramentas MCP', 'used # MCP tools'] },
  other:    { doing: ['Usando', 'Using'], done: ['Usou', 'Used'],
              gerund1: ['usando uma ferramenta', 'using a tool'], gerundN: ['usando # ferramentas', 'using # tools'],
              past1: ['usou uma ferramenta', 'used a tool'], pastN: ['usou # ferramentas', 'used # tools'] },
}

const L = (pair: [string, string], pt: boolean) => (pt ? pair[0] : pair[1])

/** The grey verb of one step row. */
export function stepVerb(step: ActivityStep, pt: boolean): string {
  const w = ACTIVITY_WORDS[step.kind]
  if (step.status === 'error') return pt ? 'Falhou' : 'Failed'
  if (step.status === 'unfinished') return pt ? 'Sem resultado' : 'No result'
  return L(step.status === 'running' ? w.doing : w.done, pt)
}

/** At most this many phrases before "and N more" — the line must stay ONE line. */
export const MAX_PHRASES = 3

/**
 * Which kinds a summary names FIRST: what CHANGED something outranks what only looked. With eleven
 * steps there is room for three phrases, and "read 2 files, ran a search" in the first slots hides
 * the file that was created — the thing the person will ask about.
 */
export const IMPACT: readonly ActivityKind[] = ['write', 'memory', 'edit', 'delegate', 'run', 'web', 'search', 'read', 'plan', 'skill', 'mcp', 'other']

/**
 * The summary line: "Criando um arquivo, atualizando 3 memórias e executando 6 comandos".
 * Phrases by IMPACT (ties keep first appearance), the first letter up. Running
 * reads in the gerund (the owner's own wording); a finished run reads in the past.
 */
export function summarize(steps: readonly ActivityStep[], running: boolean, pt: boolean): string {
  const order: ActivityKind[] = []
  const count = new Map<ActivityKind, number>()
  let unfinished = 0
  for (const s of steps) {
    if (s.status === 'unfinished') { unfinished++; continue }
    if (!count.has(s.kind)) order.push(s.kind)
    count.set(s.kind, (count.get(s.kind) ?? 0) + 1)
  }
  const phrase = (k: ActivityKind) => {
    const n = count.get(k)!
    const w = ACTIVITY_WORDS[k]
    const pair = running ? (n === 1 ? w.gerund1 : w.gerundN) : (n === 1 ? w.past1 : w.pastN)
    return L(pair, pt).replace('#', String(n))
  }
  order.sort((a, b) => IMPACT.indexOf(a) - IMPACT.indexOf(b))
  // A generic tool alongside named activity adds a count, not another "used a tool" clause.
  const other = order.length > 1 ? (count.get('other') ?? 0) : 0
  if (other) order.splice(order.indexOf('other'), 1)
  const shown = order.slice(0, MAX_PHRASES).map(phrase)
  const rest = order.slice(MAX_PHRASES).reduce((a, k) => a + count.get(k)!, 0)
  if (rest > 0) shown.push(pt ? `mais ${rest} ${rest === 1 ? 'ação' : 'ações'}` : `${rest} more ${rest === 1 ? 'action' : 'actions'}`)
  if (other > 0) shown.push(pt ? `mais ${other} ${other === 1 ? 'ferramenta' : 'ferramentas'}` : `${other} other ${other === 1 ? 'tool' : 'tools'}`)
  const joined = shown.length <= 1 ? (shown[0] ?? '')
    : `${shown.slice(0, -1).join(', ')} ${pt ? 'e' : 'and'} ${shown[shown.length - 1]}`
  const noResult = unfinished > 0
    ? (pt ? `${unfinished} ${unfinished === 1 ? 'passo' : 'passos'} sem resultado` : `${unfinished} ${unfinished === 1 ? 'step' : 'steps'} without a result`)
    : ''
  const summary = [joined, noResult].filter(Boolean).join(' · ')
  return summary ? summary[0]!.toUpperCase() + summary.slice(1) : ''
}

/** "1 min 20 s", "45 s", "2 h 03 min" — the same shape in both languages. `null` when unknown. */
export function fmtSpan(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return null
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  if (m < 60) return s % 60 ? `${m} min ${s % 60} s` : `${m} min`
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`
}

/** The run's duration: start → end (or → `now` while running). `null` when the transcript has no times. */
export function groupSpanMs(g: ActivityGroup, now: number): number | null {
  if (!g.startedAt) return null
  const a = Date.parse(g.startedAt)
  const b = g.running ? now : g.endedAt ? Date.parse(g.endedAt) : NaN
  return Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, b - a) : null
}

// ── steps ───────────────────────────────────────────────────────────────────────────────────────

/** A turn's calls as steps. The LAST call of a `pending` turn is the one running now. */
export function stepsOfTurn(turn: TurnLike): ActivityStep[] {
  const calls = turn.tools ?? []
  return calls.map((c, i) => {
    const kind = kindOf(c)
    const running = turn.pending === true && i === calls.length - 1
    return {
      kind, name: c.name, object: objectOf(c, kind),
      ...(c.detail ? { detail: c.detail } : {}), ...(c.ref ? { ref: c.ref } : {}),
      status: c.failed ? 'error' : running ? 'running' : 'done',
    }
  })
}

// ── groupings (the options) ─────────────────────────────────────────────────────────────────────

export type ChatItem<T extends TurnLike> =
  | { type: 'turn'; turn: T; index: number }
  | { type: 'activity'; group: ActivityGroup }

/**
 * OPTION B — consecutive tool calls between two things SAID become one group. A turn that carries
 * text closes the run before its text; its own calls (made after it spoke) open the next run.
 */
export function groupConsecutive<T extends TurnLike>(turns: readonly T[]): ChatItem<T>[] {
  const out: ChatItem<T>[] = []
  let cur: ActivityGroup | null = null
  const close = (endedAt?: string) => {
    if (!cur) return
    if (endedAt && !cur.running) cur.endedAt = endedAt
    out.push({ type: 'activity', group: cur })
    cur = null
  }
  turns.forEach((t, index) => {
    const said = t.text.trim() !== ''
    if (said || t.role === 'user') {
      close(t.at)
      out.push({ type: 'turn', turn: t, index })
    }
    if (t.role === 'assistant' && (t.tools?.length ?? 0) > 0) {
      cur ??= { key: `g${t.tools?.[0]?.ref ?? t.at ?? `i${index}`}`, steps: [], ...(t.at ? { startedAt: t.at } : {}), running: false }
      cur.steps.push(...stepsOfTurn(t))
      cur.running = t.pending === true
      if (t.at) cur.endedAt = t.at
    }
  })
  close()
  return out
}

/**
 * OPTION A — everything one PERSON's turn caused becomes ONE group, placed right under that person's
 * message; the assistant's sentences follow it untouched.
 */
export function groupPerExchange<T extends TurnLike>(turns: readonly T[]): ChatItem<T>[] {
  const out: ChatItem<T>[] = []
  let cur: ActivityGroup | null = null
  let slot = -1
  let said: ChatItem<T>[] = []
  const flush = (endedAt?: string) => {
    if (cur) {
      if (endedAt && !cur.running) cur.endedAt = endedAt
      out.push({ type: 'activity', group: cur })
    }
    out.push(...said)
    cur = null; said = []
  }
  let lastAt: string | undefined
  turns.forEach((t, index) => {
    if (t.role === 'user') { flush(lastAt ?? t.at); out.push({ type: 'turn', turn: t, index }); slot = index; lastAt = undefined; return }
    // The exchange lasts until the assistant's LAST turn in it — its closing sentence included.
    if (t.at) lastAt = t.at
    if (t.text.trim() !== '') said.push({ type: 'turn', turn: t, index })
    if ((t.tools?.length ?? 0) > 0) {
      cur ??= { key: `x${turns[slot]?.at ?? slot}`, steps: [], ...(t.at ? { startedAt: t.at } : {}), running: false }
      cur.steps.push(...stepsOfTurn(t))
      cur.running = t.pending === true
    }
  })
  flush(lastAt)
  return out
}

/**
 * `ChatTurn` carries no per-turn `pending`, so "is the trailing run still going" comes from the
 * SESSION: when it is working and the conversation ends on a run, that run is live and its last
 * step is the one in flight. Returns new items; the input is untouched.
 */
export function markTrailingRunning<T extends TurnLike>(items: readonly ChatItem<T>[], working: boolean): ChatItem<T>[] {
  const last = items[items.length - 1]
  if (!last || last.type !== 'activity') return [...items]
  // Not working = nothing is live: a pending step is shown unfinished, with no spinner or clock.
  if (!working) {
    const steps = last.group.steps.map(s => (s.status === 'running' ? { ...s, status: 'unfinished' as const } : s))
    return [...items.slice(0, -1), { type: 'activity', group: { ...last.group, steps, running: false } }]
  }
  const steps = last.group.steps.map((s, i, all) => (i === all.length - 1 && s.status !== 'error' ? { ...s, status: 'running' as const } : s))
  const { endedAt: _drop, ...rest } = last.group
  return [...items.slice(0, -1), { type: 'activity', group: { ...rest, steps, running: true } }]
}
