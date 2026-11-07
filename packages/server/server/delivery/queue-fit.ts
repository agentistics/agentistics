/** ORQ.H4 placement evidence: suggest extending existing queued work, without a second request registry. */
export function queueAreaSignals(brief: string): Set<string> {
  const out = new Set<string>()
  for (const m of brief.matchAll(/\b(?:packages|src|docs|engine|server)\/[\w./-]+/g)) {
    out.add(`file:${m[0].replace(/[.,:]+$/, '').toLowerCase()}`)
  }
  for (const m of brief.matchAll(/\b(?:area|área|surface)\s*[:=]\s*([^\n;]+)/gi)) {
    for (const tag of m[1]!.split(/[,|]/)) if (tag.trim()) out.add(`area:${tag.trim().toLowerCase()}`)
  }
  const surfaces: Array<[RegExp, string]> = [
    [/\bLive\b/i, 'live'], [/\b(?:task picker|seletor de tarefas)\b/i, 'task-picker'],
    [/\b(?:Histórico|History column)\b/i, 'history'], [/\b(?:Ligações|Connections)\b/i, 'connections'],
  ]
  for (const [pattern, name] of surfaces) if (pattern.test(brief)) out.add(`surface:${name}`)
  return out
}

export function sharedQueueArea(left: string, right: string): string[] {
  const other = queueAreaSignals(right)
  return [...queueAreaSignals(left)].filter(signal => other.has(signal)).sort()
}
