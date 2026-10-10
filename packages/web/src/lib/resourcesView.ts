/**
 * resourcesView.ts — PURE. The words the "Resources" panel puts on the process governor's snapshot
 * (`GET /api/resources`, server/resources/*). The server composes no wording; this does, EN + PT.
 *
 * Every alert names the CULPRIT (what it is, its pid, what it holds) and the FIX — and a fix the
 * browser cannot perform itself is a sentence with the exact command, never a button that would
 * pretend to.
 */

export type ResLang = 'en' | 'pt'

export type ProcessKind = 'server' | 'cockpit' | 'mcp' | 'watch' | 'cli' | 'helper' | 'heavy'

export interface ResProcess {
  pid: number
  kind: ProcessKind
  label: string
  usedBytes: number | null
  cpuPercent: number | null
  ageSec: number
  stale: boolean
  orphan: boolean
  owner: { kind: 'session' | 'pid'; pid: number; sessionId?: string; alive: boolean } | null
  self: boolean
  isolatedHome: boolean
  orphanWhy?: 'parent-gone' | 'cwd-deleted'
  managedId?: string
}

export interface ResAlert {
  pid: number
  label: string
  reason: 'over-budget' | 'stale-binary' | 'spinning'
  usedBytes: number | null
  budgetBytes?: number
  fix: { action: 'kill' | 'restart-server' | 'reopen-cockpit' | 'reconnect-session'; pid: number } | null
}

export interface ResKill {
  pid: number
  label: string
  reason: 'orphan-mcp' | 'owner-ended' | 'helper-idle' | 'helper-owner-ended' | 'test-leftover'
  usedBytes: number | null
  atMs: number
}

export interface ResourcesSnapshot {
  atMs: number
  measured: boolean
  inventory: ResProcess[]
  alerts: ResAlert[]
  helpers: Array<{ id: string; pid: number; name: string; idleTimeoutSec: number; budgetBytes: number; lastUsedMs: number | null }>
  heavy: {
    slots: number
    availableBytes: number | null
    running: Array<{ pid: number; command: string; sinceMs: number; slot: number; usedBytes: number | null }>
    waiting: Array<{ pid: number; command: string; sinceMs: number }>
  }
  recent: ResKill[]
  killsEnabled: boolean
  /** Absent from an older server. */
  spawnQueue?: Array<{ id: string; label: string; sinceMs: number; position: number }>
}

export function fmtMb(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return 'N/A'
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`
}

export function fmtAge(sec: number): string {
  if (sec >= 86400) return `${Math.floor(sec / 86400)}d${Math.floor((sec % 86400) / 3600)}h`
  if (sec >= 3600) return `${Math.floor(sec / 3600)}h${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}`
  return `${Math.max(0, Math.floor(sec / 60))}m`
}

const KIND: Record<ProcessKind, { en: string; pt: string }> = {
  server: { en: 'server', pt: 'servidor' },
  cockpit: { en: 'cockpit', pt: 'cockpit' },
  mcp: { en: 'MCP', pt: 'MCP' },
  watch: { en: 'daemon', pt: 'daemon' },
  cli: { en: 'command', pt: 'comando' },
  helper: { en: 'helper', pt: 'auxiliar' },
  heavy: { en: 'heavy job', pt: 'tarefa pesada' },
}
export const kindLabel = (k: ProcessKind, lang: ResLang): string => KIND[k][lang]

/** What is wrong, in one sentence that names the culprit. */
export function alertSentence(a: ResAlert, lang: ResLang): string {
  const who = `${a.label} (pid ${a.pid})`
  if (lang === 'pt') {
    if (a.reason === 'over-budget') return `${who} usa ${fmtMb(a.usedBytes)} de RAM+swap, acima do limite de ${fmtMb(a.budgetBytes)}.`
    if (a.reason === 'stale-binary') return `${who} ainda roda um agentop que uma atualização já substituiu.`
    return `${who} está com CPU alta e quem o iniciou já não existe.`
  }
  if (a.reason === 'over-budget') return `${who} uses ${fmtMb(a.usedBytes)} of RAM+swap, over its ${fmtMb(a.budgetBytes)} budget.`
  if (a.reason === 'stale-binary') return `${who} still runs an agentop an upgrade already replaced.`
  return `${who} is burning CPU and whoever started it is gone.`
}

/**
 * The fix. `button` is set only for what this page can actually do (a kill); everything else is the
 * exact sentence to act on, because a button that only describes is a button that lies.
 */
export function fixFor(a: ResAlert, lang: ResLang): { button?: string; text?: string } | null {
  if (!a.fix) return null
  const pt = lang === 'pt'
  switch (a.fix.action) {
    case 'kill':
      return { button: pt ? 'Encerrar' : 'Stop it' }
    case 'restart-server':
      return { text: pt ? 'Reinicie o servidor: agentop restart server' : 'Restart the server: agentop restart server' }
    case 'reopen-cockpit':
      return { text: pt ? 'Feche o agentop no terminal (q) e abra de novo.' : 'Quit agentop in its terminal (q) and open it again.' }
    case 'reconnect-session':
      return { text: pt ? 'Na sessão dona, reconecte o MCP (/mcp) ou reabra a sessão — encerrar levaria as ferramentas dela.' : 'In the owning session, reconnect the MCP (/mcp) or reopen the session — stopping it would take its tools away.' }
  }
}

const KILL_WHY: Record<ResKill['reason'], { en: string; pt: string }> = {
  'orphan-mcp': { en: 'its assistant was gone', pt: 'o assistente dele tinha acabado' },
  'owner-ended': { en: 'its owner session had ended', pt: 'a sessão dona tinha acabado' },
  'helper-idle': { en: 'idle past its own timeout', pt: 'ocioso além do tempo que declarou' },
  'helper-owner-ended': { en: 'its owner had ended', pt: 'o dono tinha acabado' },
  'test-leftover': { en: 'a test instance nobody owned anymore', pt: 'uma instância de teste sem dono' },
}
export function killSentence(k: ResKill, lang: ResLang): string {
  return lang === 'pt'
    ? `${k.label} (pid ${k.pid}, ${fmtMb(k.usedBytes)}) encerrado — ${KILL_WHY[k.reason].pt}.`
    : `${k.label} (pid ${k.pid}, ${fmtMb(k.usedBytes)}) stopped — ${KILL_WHY[k.reason].en}.`
}

/** The owner column. "unknown" is said, never left blank — blank reads as "nobody". */
export function ownerText(p: ResProcess, lang: ResLang): string {
  const pt = lang === 'pt'
  if (p.self) return pt ? 'este servidor' : 'this server'
  if (!p.owner) return p.orphan ? (pt ? 'nenhum (órfão)' : 'none (orphan)') : (pt ? 'desconhecido' : 'unknown')
  const id = p.owner.sessionId ? p.owner.sessionId.slice(0, 8) : `pid ${p.owner.pid}`
  return p.owner.alive ? id : `${id} — ${pt ? 'encerrado' : 'ended'}`
}

/** The heavy-slot line: how many run, how many wait, in how many slots. */
export function heavyLine(h: ResourcesSnapshot['heavy'], lang: ResLang): string {
  const avail = h.availableBytes === null ? 'N/A' : fmtMb(h.availableBytes)
  return lang === 'pt'
    ? `${h.running.length} rodando, ${h.waiting.length} na fila — ${h.slots} vaga(s) com ${avail} disponíveis.`
    : `${h.running.length} running, ${h.waiting.length} queued — ${h.slots} slot(s) with ${avail} available.`
}

/**
 * Group the alerts for display. After an upgrade EVERY session's MCP runs the replaced binary — one
 * alert each, all saying the same thing with the same fix — so they become ONE line with a count and
 * the pids; every other alert stays its own line.
 */
export function groupAlerts(alerts: ResAlert[], inventory: ResProcess[]): { single: ResAlert[]; staleMcpPids: number[] } {
  const mcp = new Set(inventory.filter(p => p.kind === 'mcp').map(p => p.pid))
  const staleMcpPids: number[] = []
  const single: ResAlert[] = []
  for (const a of alerts) {
    if (a.reason === 'stale-binary' && mcp.has(a.pid)) staleMcpPids.push(a.pid)
    else single.push(a)
  }
  return { single, staleMcpPids }
}

export function staleMcpSentence(pids: number[], lang: ResLang): string {
  return lang === 'pt'
    ? `${pids.length} servidor(es) MCP de sessões abertas ainda rodam o agentop anterior à atualização (pid ${pids.join(', ')}).`
    : `${pids.length} MCP server(s) of open sessions still run the agentop from before the upgrade (pid ${pids.join(', ')}).`
}

// ── RES.ACTIONS — the buttons that fix what the panel reports ────────────────────────────────────

/** Processes the user can end because whoever started them is gone. Never this server. */
export const orphansOf = (inv: ResProcess[]): ResProcess[] => inv.filter(p => p.orphanWhy && !p.self)

export interface FleetLite { id: string; title: string; harness: string }

export interface StaleSessionGroup {
  /** The owning session, when it is still in the fleet; `null` = its session is gone (an orphan). */
  session: FleetLite | null
  managedId: string | null
  pids: number[]
}

/** Stale MCP processes, grouped by the session that owns them. */
export function staleBySession(inv: ResProcess[], alerts: ResAlert[], fleet: ReadonlyMap<string, FleetLite>): StaleSessionGroup[] {
  const stale = new Set(alerts.filter(a => a.reason === 'stale-binary').map(a => a.pid))
  const groups = new Map<string, StaleSessionGroup>()
  for (const p of inv) {
    if (p.kind !== 'mcp' || !stale.has(p.pid)) continue
    const key = p.managedId ?? `pid:${p.pid}`
    const g = groups.get(key) ?? { session: p.managedId ? (fleet.get(p.managedId) ?? null) : null, managedId: p.managedId ?? null, pids: [] }
    g.pids.push(p.pid)
    groups.set(key, g)
  }
  return [...groups.values()]
}

/** "Claude 3, Gemini 3, Kimi 1" — sessions per harness (a harness label is passed in). */
export function harnessBreakdown(groups: StaleSessionGroup[], label: (h: string) => string): string {
  const n = new Map<string, number>()
  for (const g of groups) if (g.session) n.set(label(g.session.harness), (n.get(label(g.session.harness)) ?? 0) + 1)
  return [...n].map(([h, c]) => `${h} ${c}`).join(', ')
}

export function staleSessionsSentence(groups: StaleSessionGroup[], breakdown: string, lang: ResLang): string {
  const pt = lang === 'pt'
  const tail = breakdown ? ` (${breakdown})` : ''
  return pt
    ? `${groups.length} sessão(ões)${tail} ainda usam o agentop antigo. Continuam funcionando — reabra a sessão quando quiser a versão nova.`
    : `${groups.length} session(s)${tail} still use the old agentop. They keep working — reopen a session when you want the new version.`
}

export interface RecommendedActions { orphanCount: number; orphanBytes: number; reopenCount: number }

export function recommendedActions(inv: ResProcess[], groups: StaleSessionGroup[]): RecommendedActions {
  const o = orphansOf(inv)
  return {
    orphanCount: o.length,
    orphanBytes: o.reduce((a, p) => a + (p.usedBytes ?? 0), 0),
    reopenCount: groups.filter(g => g.session).length,
  }
}

export function recommendedSentence(r: RecommendedActions, lang: ResLang): string | null {
  const parts: string[] = []
  const pt = lang === 'pt'
  if (r.orphanCount > 0) parts.push(pt ? `encerrar ${r.orphanCount} órfão(s)` : `end ${r.orphanCount} orphan(s)`)
  if (r.reopenCount > 0) parts.push(pt ? `reabrir ${r.reopenCount} sessão(ões)` : `reopen ${r.reopenCount} session(s)`)
  if (!parts.length) return null
  const free = r.orphanBytes > 0 ? `${fmtMb(r.orphanBytes)}` : ''
  return `${pt ? 'Liberar' : 'Free'}${free ? ` ~${free}` : ''}: ${parts.join(' · ')}`
}

export function orphanWhySentence(p: ResProcess, lang: ResLang): string {
  const pt = lang === 'pt'
  return p.orphanWhy === 'cwd-deleted'
    ? (pt ? 'órfão de uma prévia/teste cuja pasta já foi apagada' : 'orphan of a preview/test whose folder was deleted')
    : (pt ? 'órfão: quem o iniciou já acabou' : 'orphan: whoever started it is gone')
}

/** What to tell the user after the kill route answered. Only a CONFIRMED exit says "ended". */
export function endNote(pid: number, r: { ended: boolean } | null, lang: ResLang): string {
  const pt = lang === 'pt'
  if (r?.ended) return pt ? `pid ${pid} encerrado.` : `pid ${pid} ended.`
  return pt ? `O pid ${pid} não encerrou. Tente de novo.` : `pid ${pid} did not end. Try again.`
}
