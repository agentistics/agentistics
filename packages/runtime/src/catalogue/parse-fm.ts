/**
 * catalogue/parse-fm.ts — adapts `splitFrontmatter` to what the parsers want: a field map that is
 * never null, plus whether the file HAD frontmatter (a file without any is its own sentence).
 */

import { splitFrontmatter, type FmError, type FmField } from './frontmatter.ts'

export interface FmView {
  fields: Map<string, FmField>
  body: string
  bodyStartLine: number
  errors: FmError[]
  hadFrontmatter: boolean
}

export function frontmatterOrEmpty(text: string): FmView {
  const r = splitFrontmatter(text)
  return { fields: r.frontmatter ?? new Map(), body: r.body, bodyStartLine: r.bodyStartLine, errors: r.errors, hadFrontmatter: r.frontmatter !== null }
}
