/**
 * catalogue/problems.ts — how a finding becomes a sentence with `file:line`, and what a finding
 * does to its entry (it DISABLES it; it never removes it — §3.2, criterion 4).
 */

import type { CatalogueEntry, CatalogueKind, CatalogueLang, CatalogueProblem } from './types.ts'

export function problem(code: string, path: string, line: number, en: string, pt: string): CatalogueProblem {
  return { code, path, line: line > 0 ? line : 1, en, pt }
}

/** `path:line: sentence` — the form `/catalogue` prints. */
export function problemSentence(p: CatalogueProblem, lang: CatalogueLang = 'en'): string {
  return `${p.path}:${p.line}: ${lang === 'pt' ? p.pt : p.en}`
}

/**
 * Adds findings to an entry. Any finding switches the entry OFF and keeps it listed: an entry
 * that half-works is the silent failure this directory exists to prevent.
 */
export function withProblems<K extends CatalogueKind>(entry: CatalogueEntry<K>, found: readonly CatalogueProblem[]): CatalogueEntry<K> {
  if (found.length === 0) return entry
  return { ...entry, enabled: false, problems: [...entry.problems, ...found] }
}
