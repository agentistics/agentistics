/**
 * catalogue/ — the native harness catalogue's PURE core (B8.1, spec §3): the entry shape, the
 * parsers (from TEXT, never a path read), strict validation, precedence and shadowing, the
 * narrowing plans, and problems as sentences with file:line. The host loader is B8.2's.
 *
 * `jsonc.ts`, `frontmatter.ts` and `parse-fm.ts` are internal readers and are deliberately not
 * re-exported: their names are generic enough to collide in the package index, and nothing outside
 * this directory needs them.
 */
export * from './types.ts'
export { problemSentence, withProblems } from './problems.ts'
export * from './floor-target.ts'
export * from './parse.ts'
export * from './precedence.ts'
