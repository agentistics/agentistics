/**
 * strip-comments.ts — the server-side twin of `packages/web/src/lib/stripComments.ts`.
 *
 * That module exists because a source-scanning test has one trap: a file that documents a rule
 * necessarily contains, in prose, the very shape the rule forbids, so an un-stripped scan can pass
 * on a comment rather than on code. The web package's own lint test (`stripComments.test.ts`)
 * enforces that every scan in ITS tree goes through the one implementation there — but a server test
 * cannot reach across the package boundary into `packages/web/src` (Vite-only code lives there, and
 * nothing in this repo imports across that boundary in either direction). This is that same,
 * unweakened algorithm, ported once so a future server-side source scan has somewhere correct to go
 * instead of writing its own — see `response-policy-composition.test.ts` for the first caller.
 */
export function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}
