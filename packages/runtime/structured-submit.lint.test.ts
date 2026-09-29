/**
 * structured-submit.lint.test.ts — `result.submit` cannot write anything outside the return channel
 * (TOOL.1 acceptance criterion 6). Two claims, one over the tool TABLE and one over the SOURCE:
 *
 *  1. In the table a run is actually handed, `result.submit` is class `auto` and declares NO effects
 *     — `subjects()` is empty for every input, so the policy never grants it a path, a command or a
 *     question — and the native catalogue does not carry it (only a structured run does).
 *  2. Its module imports only the contract, `defineTool` and the pure validator, and names no host
 *     API (fs, child_process, network, process, Bun). A future edit that gives it an effect must
 *     change this test, which is the review gate.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { createNativeTools } from './src/tools/catalogue.ts'
import type { Tool, ToolContext } from './src/tools/contract.ts'
import { createResultSubmitTool, RESULT_SUBMIT_TOOL } from './src/tools/result/submit.ts'
import { compileSchema } from './src/structured/schema.ts'
import { stripComments } from './tools-gate.lint.test.ts'

const SOURCE = join(import.meta.dir, 'src/tools/result/submit.ts')

function schema() {
  const c = compileSchema({ type: 'object', properties: { a: { type: 'string' } }, required: ['a'] })
  if (!c.ok) throw new Error(c.problems.join(' '))
  return c.schema
}

const ctx: ToolContext = {
  workspaceRoot: '/ws', cwd: '/ws', signal: new AbortController().signal, toolExecutionId: 'tx_lint', now: () => new Date(0),
}

describe('result.submit — the tool table', () => {
  test('a structured run\'s table: result.submit is auto and has no effects for any input', async () => {
    const native = createNativeTools()
    try {
      const table: Tool<unknown>[] = [...native.tools, createResultSubmitTool(schema()) as Tool<unknown>]
      const submits = table.filter(t => t.name === RESULT_SUBMIT_TOOL)
      expect(submits.length).toBe(1)
      const submit = submits[0]!
      expect(submit.permission).toBe('auto')
      const inputs: unknown[] = [
        { value: { a: 'x' } }, { value: null }, { value: '/etc/passwd' }, { value: { path: '/ws/f', command: 'rm -rf /' } },
        { value: Array.from({ length: 50 }, (_, i) => i) },
      ]
      for (const raw of inputs) {
        const parsed = submit.parse(raw)
        expect(typeof parsed).not.toBe('string')
        expect(await submit.subjects(parsed, ctx)).toEqual([])
      }
    } finally {
      await native.dispose()
    }
  })

  test('the native catalogue does not carry result.submit (only a structured run adds it)', async () => {
    const native = createNativeTools()
    try {
      expect(native.tools.map(t => t.name)).not.toContain(RESULT_SUBMIT_TOOL)
    } finally {
      await native.dispose()
    }
  })
})

describe('result.submit — the source', () => {
  const src = stripComments(readFileSync(SOURCE, 'utf8'))

  test('imports only the contract, defineTool and the pure validator', () => {
    const froms = [...src.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map(m => m[1]).sort()
    expect(froms).toEqual(['../../structured/schema.ts', '../contract.ts', '../define.ts'])
  })

  test('names no host API', () => {
    for (const needle of [/\bnode:/, /['"]fs['"]/, /child_process/, /\bBun\./, /\bprocess\./, /\bfetch\s*\(/, /\bspawn\b/, /\bwriteFile/, /\brequire\s*\(/, /\bimport\s*\(/]) {
      expect(needle.test(src)).toBe(false)
    }
  })

  test('its subjects are the frozen empty constant, not derived from the input', () => {
    expect(src).toMatch(/subjects:\s*async\s*\(\)\s*=>\s*RESULT_SUBMIT_SUBJECTS/)
    expect(src).toMatch(/RESULT_SUBMIT_SUBJECTS[^=]*=\s*Object\.freeze\(\[\]\)/)
  })
})
