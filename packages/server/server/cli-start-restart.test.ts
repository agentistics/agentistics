/**
 * The native restart the cockpit and `agentop restart --all` share (`restartLocalSvc`) used to call a
 * restart done once ANY server answered the health check — including the old one, when it had not
 * stopped. It now shares `awaitReplacement` with `restartAutostart`; this pins the sentence each
 * verdict earns, and that the control center's restart verb surfaces it.
 */
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cliStrings } from './cli-i18n'
import { localRestartOutcome } from './cli-start'

const en = cliStrings('en')
const pt = cliStrings('pt')

test('a different pid answering is the only thing that counts as restarted', () => {
  expect(localRestartOutcome({ kind: 'replaced', before: 10, after: 20 }, en)).toEqual({ ok: true })
  expect(localRestartOutcome({ kind: 'replaced', before: null, after: 20 }, en)).toEqual({ ok: true })
})

test('the old server still serving is refused in a sentence that names its pid, EN and PT', () => {
  const v = { kind: 'unchanged', pid: 10 } as const
  const e = localRestartOutcome(v, en)
  expect(e.ok).toBe(false)
  expect(e.ok === false && e.message).toContain('pid 10')
  expect(e.ok === false && e.message).toContain('kill 10')
  const p = localRestartOutcome(v, pt)
  expect(p.ok === false && p.message).toContain('pid 10')
  expect(p.ok === false && p.message).not.toBe(e.ok === false ? e.message : '')
})

test('nothing answering keeps the existing "did not come back up" sentence', () => {
  const r = localRestartOutcome({ kind: 'silent', before: 10 }, en)
  expect(r).toEqual({ ok: false, message: en.localStartFailed })
})

test('the control center restart verb and the native restart surface the specific sentence', () => {
  const src = readFileSync(join(import.meta.dir, 'cli-start.ts'), 'utf8')
  const verb = src.slice(src.indexOf('async restart(target: ActionTarget'))
  expect(verb).toContain('mode.failure')
  const native = src.slice(src.indexOf('export async function restartNativeServer'), src.indexOf('export async function restartAllServices'))
  expect(native).toContain('mode.failure')
})
