/**
 * SessionChat.noQuestionsConfirm.lint.test.ts — choosing "no questions" goes through a confirm modal,
 * and a successful mode change leaves no notice under the composer band. Source-level pin (no jsdom).
 */
import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = readFileSync(join(import.meta.dir, 'SessionChat.tsx'), 'utf8')

function body(start: string, end: string): string {
  const a = src.indexOf(start)
  const b = src.indexOf(end, a)
  expect(a).toBeGreaterThan(-1)
  expect(b).toBeGreaterThan(a)
  return src.slice(a, b)
}

test('chooseMode routes the no-questions option to the confirm instead of switching', () => {
  const choose = body('const chooseMode = useCallback', 'EXT.OPEN: the one question')
  expect(choose).toContain("opt.canonical === 'no-questions'")
  expect(choose).toContain('setNoQuestionsAsk(target)')
  expect(choose.indexOf('setNoQuestionsAsk(target)')).toBeLessThan(choose.indexOf('await switchMode(target)'))
})

test('only the modal confirm calls the real switch', () => {
  expect(src).toMatch(/onConfirm=\{\(\) => \{ const target = noQuestionsAsk;[^}]*void switchMode\(target\)/)
  expect(src).toContain("'Ativar o modo sem perguntas?'")
})

test('a successful mode change sets no notice; only failures do', () => {
  const sw = body('const switchMode = useCallback', 'const chooseMode = useCallback')
  expect(sw).not.toContain('modeOptions.find')
  expect(sw.match(/setNotice\(out\.message\)/g)?.length).toBe(2)
  expect(sw).toContain('if (!out.ok) setNotice(out.message)')
})
