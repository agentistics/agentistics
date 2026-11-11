/**
 * scopeSentence.ts — PURE. What the filter bar is currently selecting, in words.
 *
 * A totals panel is the one surface where "which numbers am I looking at" cannot be left to the
 * chips above it. Somebody reads a figure in the billions, scrolls, and quotes it — and if the
 * panel never said "last 30 days, two projects", the figure travels without its scope and becomes
 * wrong the moment it is repeated. So the panel states its own scope, next to its own numbers.
 *
 * Only what is actually NARROWING is named. A sentence reciting every dimension at its default is
 * noise, and noise is what people learn to skip.
 */

import type { Filters, Lang } from '@agentistics/core'

const RANGE: Record<string, Record<Lang, string>> = {
  '7d': { en: 'last 7 days', pt: 'últimos 7 dias' },
  '30d': { en: 'last 30 days', pt: 'últimos 30 dias' },
  '90d': { en: 'last 90 days', pt: 'últimos 90 dias' },
  all: { en: 'all time', pt: 'todo o período' },
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

/**
 * The active scope as one already-localized clause, e.g. `últimos 30 dias · 2 projetos`.
 *
 * The DATE is always stated, even at its default, because a total is meaningless without a window
 * and "all time" is a real and important answer — it is the reading people most often assume when
 * they should not.
 */
export function scopeSentence(filters: Filters, lang: Lang): string {
  const parts: string[] = []

  if (filters.customStart || filters.customEnd) {
    const from = filters.customStart || '…'
    const to = filters.customEnd || '…'
    parts.push(lang === 'pt' ? `${from} até ${to}` : `${from} to ${to}`)
  } else {
    parts.push(RANGE[filters.dateRange]?.[lang] ?? String(filters.dateRange))
  }

  const n = (xs: readonly unknown[] | undefined) => xs?.length ?? 0
  if (n(filters.projects) > 0) {
    parts.push(plural(n(filters.projects), lang === 'pt' ? 'projeto' : 'project', lang === 'pt' ? 'projetos' : 'projects'))
  }
  if (n(filters.repos) > 0) {
    parts.push(plural(n(filters.repos), lang === 'pt' ? 'repositório' : 'repository', lang === 'pt' ? 'repositórios' : 'repositories'))
  }
  if (n(filters.models) > 0) {
    parts.push(plural(n(filters.models), lang === 'pt' ? 'modelo' : 'model', lang === 'pt' ? 'modelos' : 'models'))
  }
  // `harness` (single) and `harnesses` (multi) are two controls for one dimension, and both can be
  // set. Named once, by the count of what is actually selected.
  const harnesses = new Set<string>([
    ...(filters.harnesses ?? []),
    ...(filters.harness ? [filters.harness] : []),
  ])
  if (harnesses.size > 0) {
    parts.push(plural(harnesses.size, lang === 'pt' ? 'assistente' : 'assistant', lang === 'pt' ? 'assistentes' : 'assistants'))
  }
  if (n(filters.tags) > 0) {
    parts.push(plural(n(filters.tags), 'tag', lang === 'pt' ? 'tags' : 'tags'))
  }

  return parts.join(' · ')
}

/** True when anything beyond the date range is narrowing the view. */
export function scopeIsNarrowed(filters: Filters): boolean {
  return (filters.projects?.length ?? 0) > 0
    || (filters.repos?.length ?? 0) > 0
    || (filters.models?.length ?? 0) > 0
    || (filters.harnesses?.length ?? 0) > 0
    || Boolean(filters.harness)
    || (filters.tags?.length ?? 0) > 0
}
