/**
 * fixture-gate.ts — PURE. The one definition of what an Anthropic fixture may never carry (spec
 * docs/superpowers/specs/2026-09-25-runtime-b1-provider.md §6.3.3 "Fixtures", §15 B1.5).
 *
 * Two readers, one gate: the owner-run recorder (`packages/server/scripts/record-anthropic-fixtures.ts`)
 * calls `assertFixtureClean` before a byte reaches the fixtures directory, and
 * `fixtures-redaction.test.ts` runs the same function over every file already there. It lives in
 * the runtime because the fixtures are the runtime's (`packages/runtime/test/fixtures/provider/anthropic`)
 * and a runtime test may not import a host script (D23). It lives under `test/`, OUTSIDE `src/`, and
 * is not exported from the package: it is fixture tooling, not runtime code, and keeping it out of
 * `src/` keeps its header-name vocabulary out of `provider-secrets.lint.test.ts`'s walk with no
 * exemption — exactly where it stood when it lived beside the recorder script.
 */
import { redactSecrets } from '@agentistics/core'

/**
 * Substrings that must never appear in a fixture, lower-cased and compared case-insensitively.
 * Spelled out (not derived) so the list a reviewer reads is the list that runs.
 */
export const FORBIDDEN_NEEDLES: readonly string[] = [
  'sk-ant-',
  'x-api-key',
  'authorization',
  'anthropic-organization-id',
  'anthropic-workspace-id',
  'set-cookie',
  'cookie',
  'bearer ',
]

/**
 * Throws when `text` carries anything a fixture may not: a forbidden needle, or anything
 * `@agentistics/core`'s `redactSecrets` would rewrite (its patterns are the repo's one definition of
 * "secret-shaped"). Returns nothing; the only success is not throwing.
 */
export function assertFixtureClean(text: string): void {
  const hay = text.toLowerCase()
  const hits = FORBIDDEN_NEEDLES.filter(n => hay.includes(n))
  if (hits.length > 0) throw new Error(`fixture refused: contains ${hits.map(h => JSON.stringify(h)).join(', ')}`)
  if (redactSecrets(text) !== text) throw new Error('fixture refused: redactSecrets would rewrite part of it')
}
