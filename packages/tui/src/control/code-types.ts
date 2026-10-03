/**
 * code-types.ts — the contract between the `code` tab (this package) and the engine that drives
 * native runtime sessions for it. Since the engine split it IS `@agentistics/engine-api`'s `code.ts`
 * (1.8): re-exported here under the names the tab has always used, so the tab and every engine read
 * one definition. Spec: docs/superpowers/specs/2026-09-28-harness-tui-design.md.
 */
export type * from '@agentistics/engine-api'
export type { CodeTabHost as CodeHost } from '@agentistics/engine-api'
