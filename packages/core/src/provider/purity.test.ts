import { describe, expect, it } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as core from '../index'

// B1.1's acceptance, made executable: the five contract modules are PURE (spec §15 B1.1: "no IO
// import"), name no credential (spec §4.1: a source guard in the `billing-detect.test.ts` shape
// fails if `apiKey`, `x-api-key` or `authorization` appears in any core module), and are reachable
// from the `@agentistics/core` barrel.

const MODULES = ['usage', 'stop-reason', 'errors', 'retry-plan', 'edit-policy'] as const

/** Comments are stripped first: a module is allowed to EXPLAIN what it refuses to hold. */
function code(name: string): string {
  return readFileSync(join(import.meta.dir, `${name}.ts`), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

describe('provider contract — purity', () => {
  for (const name of MODULES) {
    it(`${name}.ts exists`, () => {
      expect(existsSync(join(import.meta.dir, `${name}.ts`))).toBe(true)
    })

    it(`${name}.ts imports nothing but core modules`, () => {
      const specifiers = [...code(name).matchAll(/\bfrom\s+['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]/g)]
        .map(m => m[1] ?? m[2] ?? '')
      for (const s of specifiers) expect(s.startsWith('./') || s.startsWith('../')).toBe(true)
      expect(code(name)).not.toMatch(/\b(process\.|Bun\.|fetch\s*\(|require\s*\()/)
    })

    it(`${name}.ts names no credential`, () => {
      expect(code(name)).not.toMatch(/apiKey|api_key|x-api-key|authorization|bearer/i)
    })
  }
})

describe('provider contract — exported from @agentistics/core', () => {
  it('carries every entry point of the five modules', () => {
    for (const name of [
      'fromAnthropicUsage', 'providerUsageTokens', 'toModelUsage', 'usagePricing',
      'classifyProviderError', 'pickClassifierInput', 'PROVIDER_ERROR_KINDS',
      'decideRetry', 'DEFAULT_RETRY_POLICY',
      'fromAnthropicStopReason', 'STOP_REASON_KINDS',
      'ANTHROPIC_EDIT_POLICY', 'mayReplace',
    ]) expect(name in core).toBe(true)
  })
})
