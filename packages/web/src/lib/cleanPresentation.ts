import type { CleanWebItem } from '@agentistics/core'
export type CleanFilter = 'all' | 'worktrees' | 'node-modules' | 'idle'
export type CleanSort = 'name' | 'project' | 'idle' | 'bytes'
export function cleanSize(bytes: number, lang: 'pt' | 'en'): string {
  const n = Math.max(0, bytes)
  const unit = n >= 1024 ** 3 ? 'GB' : n >= 1024 ** 2 ? 'MB' : n >= 1024 ? 'KB' : 'B'
  const divisor = unit === 'GB' ? 1024 ** 3 : unit === 'MB' ? 1024 ** 2 : unit === 'KB' ? 1024 : 1
  return `${new Intl.NumberFormat(lang, { maximumFractionDigits: unit === 'GB' ? 1 : 0 }).format(n / divisor)} ${unit}`
}
/** A folder du could not measure says so; its stored 0 is not a size. */
export function cleanItemSize(item: Pick<CleanWebItem, 'bytes' | 'bytesUnknown'>, lang: 'pt' | 'en'): string {
  return item.bytesUnknown ? (lang === 'pt' ? 'não medido' : 'not measured') : cleanSize(item.bytes, lang)
}
/** One finished line of the live scan: the MEASURED size, then what happens to it. */
export function cleanLogSize(line: { bytes?: number; kept?: boolean; freeBytes?: number; unknown?: boolean }, lang: 'pt' | 'en'): string {
  const pt = lang === 'pt'
  if (line.unknown) return pt ? 'não medido' : 'not measured'
  const size = cleanSize(line.bytes ?? 0, lang)
  if (line.kept) return `${size} · ${pt ? 'mantido' : 'kept'}`
  if (line.freeBytes !== undefined && line.freeBytes !== line.bytes) return `${size} · ${pt ? 'libera' : 'frees'} ${cleanSize(line.freeBytes, lang)}`
  return `${size} · ${pt ? 'libera' : 'frees'} ${size}`
}
export function cleanName(item: Pick<CleanWebItem, 'name' | 'path' | 'kind'>): string {
  const name = item.name || (item.path.replace(/\\/g, '/').replace(/\/$/, '').split('/').pop() || item.path)
  return item.kind === 'node-modules' ? name.replace(/\/node_modules$/, '') : name
}
export function cleanIdle(ms: number | null, now: number, lang: 'pt' | 'en'): string {
  if (ms === null) return '—'
  const hours = Math.max(0, Math.floor((now - ms) / 3_600_000))
  if (hours < 1) return lang === 'pt' ? 'agora' : 'now'
  if (hours < 24) return `${hours} h`
  const days = Math.floor(hours / 24)
  return lang === 'pt' ? `${days} ${days === 1 ? 'dia' : 'dias'}` : `${days} ${days === 1 ? 'day' : 'days'}`
}
export function cleanKind(kind: string, pt: boolean): string {
  return ({ remove: pt ? 'Worktrees já mergeados' : 'Merged worktrees', 'node-modules': pt ? 'node_modules reinstaláveis' : 'Reinstallable node_modules', prune: pt ? 'Registros de pastas que sumiram' : 'Missing folder records', keep: pt ? 'Mantidos por segurança' : 'Kept for safety' } as Record<string, string>)[kind] ?? kind
}
export function cleanReason(reason: string, pt: boolean): string {
  const words: Record<string, [string, string]> = {
    main: ['pasta principal', 'main checkout'], locked: ['travado', 'locked'], dirty: ['mudanças não commitadas', 'uncommitted changes'], active: ['em uso', 'in use'], unmerged: ['não mergeado', 'not merged'],
    'merged and clean': ['mergeado e limpo', 'merged and clean'], 'directory is gone': ['a pasta não existe mais', 'directory is gone'],
    'no commit in 30+ days': ['sem commit há 30+ dias', 'no commit in 30+ days'], 'changed since the plan': ['mudou desde a varredura', 'changed since the scan'],
    'the server working directory': ['pasta do servidor', 'server working directory'], 'an active session': ['sessão ativa', 'active session'],
    'a process is running inside it (or its location is unknown)': ['há um processo dentro (ou localização desconhecida)', 'a process is running inside (or its location is unknown)'],
  }
  return words[reason]?.[pt ? 0 : 1] ?? reason
}
export function cleanMatches(item: CleanWebItem, filter: CleanFilter, now: number): boolean {
  if (filter === 'worktrees') return item.kind === 'remove' || item.kind === 'prune'
  if (filter === 'node-modules') return item.kind === 'node-modules'
  if (filter === 'idle') return item.lastActivityMs !== null && now - item.lastActivityMs > 7 * 86_400_000
  return true
}
export function sortCleanItems(items: readonly CleanWebItem[], sort: CleanSort, descending: boolean, selectableFirst = false): CleanWebItem[] {
  return [...items].sort((a, b) => {
    if (selectableFirst && (a.kind === 'keep') !== (b.kind === 'keep')) return a.kind === 'keep' ? 1 : -1
    const value = sort === 'bytes' ? a.bytes - b.bytes : sort === 'idle' ? (a.lastActivityMs ?? Infinity) - (b.lastActivityMs ?? Infinity)
      : sort === 'name' ? cleanName(a).localeCompare(cleanName(b)) : a.project.localeCompare(b.project)
    return (descending ? -value : value) || a.id.localeCompare(b.id)
  })
}

/** Select-all operates on the filtered rows, preserving selections hidden by another filter. */
export function toggleCleanVisible(picked: ReadonlySet<string>, visible: readonly CleanWebItem[]): Set<string> {
  const selectable = visible.filter(i => i.kind !== 'keep')
  const all = selectable.length > 0 && selectable.every(i => picked.has(i.id))
  const next = new Set(picked)
  for (const item of selectable) all ? next.delete(item.id) : next.add(item.id)
  return next
}
export function initialCleanSelection(items: readonly CleanWebItem[]): Set<string> {
  return new Set(items.filter(i => i.kind !== 'keep' && i.kind !== 'node-modules').map(i => i.id))
}
