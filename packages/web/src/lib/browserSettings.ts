/**
 * PURE — what Settings → Browser says about the built-in browser (NAVEGADOR S12). `GET /api/browser/status`
 * holds the numbers (the thresholds come from the server's `browser-spec.ts`, never restated here); this
 * module only turns them into the sentences the rows print.
 */
export interface BrowserLiveView {
  key: string
  owner: { kind: 'session'; managedId: string } | { kind: 'personal' }
  memory: { basis: 'pss' | 'rss' | 'none'; bytes: number | null; action: 'ok' | 'trim' | 'kill' } | null
}

export interface BrowserStatusView {
  executable: { found: boolean; path?: string; kind?: string; source?: string; sentence: string }
  live: BrowserLiveView[]
  ceilings: { live: number }
  memory: { available: number | null; minAvailable: number; trimBytes: number; killBytes: number; rssFallbackFactor: number }
  profiles: { count: number }
}

export function fmtBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`
  return `${Math.round(n / 1024 ** 2)} MB`
}

export type MemoryTone = 'ok' | 'trim' | 'kill'

export interface MemoryLine { label: string; value: string; tone: MemoryTone }

/** One line per live browser. `null` bytes is "not measured yet", never a 0. */
export function memoryLines(live: BrowserLiveView[], pt: boolean): MemoryLine[] {
  return live.map((b) => {
    const label = b.owner.kind === 'personal'
      ? (pt ? 'Navegador pessoal' : 'Personal browser')
      : `${pt ? 'Sessão' : 'Session'} ${b.owner.managedId.replace(/^agentop-/, '').slice(0, 8)}`
    const m = b.memory
    const value = !m || m.bytes === null
      ? (pt ? 'ainda sem medida' : 'not measured yet')
      : `${fmtBytes(m.bytes)} ${m.basis === 'rss' ? 'RSS' : 'PSS'}`
    return { label, value, tone: m?.action ?? 'ok' }
  })
}

/** Total of what is measured, or `null` when nothing is. */
export function totalBytes(live: BrowserLiveView[]): number | null {
  const parts = live.map(b => b.memory?.bytes).filter((x): x is number => typeof x === 'number')
  return parts.length ? parts.reduce((a, b) => a + b, 0) : null
}

/** The line under the memory header: what each browser is held to, and what is free to start another. */
export function ceilingSentence(s: BrowserStatusView, pt: boolean): string {
  const trim = fmtBytes(s.memory.trimBytes)
  const kill = fmtBytes(s.memory.killBytes)
  const free = s.memory.available === null
    ? (pt ? 'memória livre desconhecida' : 'free memory unknown')
    : `${fmtBytes(s.memory.available)} ${pt ? 'livres' : 'free'}`
  return pt
    ? `Cada navegador fecha a aba mais antiga acima de ${trim} e é encerrado acima de ${kill} (PSS). No máximo ${s.ceilings.live} ao mesmo tempo; um novo só sobe com ${fmtBytes(s.memory.minAvailable)} livres (agora: ${free}).`
    : `Each browser closes its oldest tab above ${trim} and is stopped above ${kill} (PSS). At most ${s.ceilings.live} at once; a new one starts only with ${fmtBytes(s.memory.minAvailable)} free (now: ${free}).`
}

export const SOURCE_LABEL: Record<string, { en: string; pt: string }> = {
  env: { en: 'set by AGENTISTICS_BROWSER_BIN', pt: 'definido por AGENTISTICS_BROWSER_BIN' },
  playwright: { en: 'found in the Playwright cache', pt: 'achado no cache do Playwright' },
  path: { en: 'found on the PATH', pt: 'achado no PATH' },
  system: { en: 'found in the system', pt: 'achado no sistema' },
}

/** Executable row: value + how it was found. Not found = the server's own sentence. */
export function executableLine(e: BrowserStatusView['executable'], pt: boolean): { value: string; sub: string } {
  if (!e.found) return { value: pt ? 'nenhum' : 'none', sub: e.sentence }
  const how = (e.source && SOURCE_LABEL[e.source]) ? (pt ? SOURCE_LABEL[e.source]!.pt : SOURCE_LABEL[e.source]!.en) : (e.source ?? '')
  return { value: e.path ?? '', sub: `${e.kind ?? ''}${how ? ` · ${how}` : ''}` }
}

/** The "delete profiles" row's sub line, and whether the button may be pressed. */
export function profilesRow(s: BrowserStatusView, pt: boolean): { sub: string; canDelete: boolean } {
  if (s.live.length > 0) {
    return {
      canDelete: false,
      sub: pt ? 'Há um navegador aberto agora. Feche-o (ou espere ele fechar sozinho) para apagar os perfis.'
        : 'A browser is open right now. Close it (or wait for it to close by itself) to delete profiles.',
    }
  }
  if (s.profiles.count === 0) return { canDelete: false, sub: pt ? 'Não há perfis guardados.' : 'There are no stored profiles.' }
  return {
    canDelete: true,
    sub: pt ? `${s.profiles.count} pasta(s) de perfil (cookies e cache dos navegadores já encerrados).`
      : `${s.profiles.count} profile folder(s) (cookies and cache of browsers already closed).`,
  }
}

/** Per-harness support lines (SPEC §3): only the ones that need saying. */
export function harnessLines(pt: boolean): { id: string; name: string; text: string }[] {
  return [
    {
      id: 'antigravity', name: 'Antigravity',
      text: pt ? 'O Antigravity tem navegador próprio. Se o modelo usar o dele, ele não aparece aqui.'
        : 'Antigravity has its own browser. If the model uses it, it does not show up here.',
    },
    {
      id: 'hermes', name: 'Hermes',
      text: pt ? 'Hermes ainda não recebe as ferramentas de navegador do agentistics.'
        : 'Hermes does not receive the agentistics browser tools yet.',
    },
  ]
}
