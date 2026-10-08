import { expect, test } from 'bun:test'
import { shellRunViewModel } from '../../lib/shellRun'

const run = (output?: { stdout: string; stderr: string }) => ({
  command: 'mkdir -p a b && cp x y', summary: 'cp x y', running: false, ...(output ? { output } : {}),
})

test('the shell bubble model is one command block with empty output explicitly represented', () => {
  const model = shellRunViewModel(run({ stdout: '', stderr: '' }))
  expect(model).toEqual({ lines: 0, hasOut: false, expandedByDefault: false })
})

test('shell output up to twelve lines starts expanded, longer output starts collapsed', () => {
  expect(shellRunViewModel(run({ stdout: Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n'), stderr: '' })).expandedByDefault).toBe(true)
  expect(shellRunViewModel(run({ stdout: Array.from({ length: 13 }, (_, i) => `line ${i}`).join('\n'), stderr: '' })).expandedByDefault).toBe(false)
})

test("Claude Code's '(Bash completed with no output)' reads as no output", () => {
  expect(shellRunViewModel(run({ stdout: '(Bash completed with no output)', stderr: '' }))).toEqual({ lines: 0, hasOut: false, expandedByDefault: false })
})
