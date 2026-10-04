import { describe, expect, test } from 'bun:test'
import { opensCockpit, parseCodeLaunch } from './code-launch'

describe('opensCockpit', () => {
  test('a terminal on both ends, and not for ls / --help / -h', () => {
    expect(opensCockpit([], { stdin: true, stdout: true })).toBe(true)
    expect(opensCockpit(['fix it'], { stdin: true, stdout: true })).toBe(true)
    for (const a of ['ls', '--help', '-h']) expect(opensCockpit([a], { stdin: true, stdout: true })).toBe(false)
    expect(opensCockpit([], { stdin: false, stdout: true })).toBe(false)
    expect(opensCockpit([], { stdin: true, stdout: false })).toBe(false)
  })
})

describe('parseCodeLaunch', () => {
  test('a prompt, --model, --cwd', () => {
    expect(parseCodeLaunch(['fix', 'the', 'bug', '--model', 'm1', '--cwd', '/w'])).toEqual({ ok: true, start: { launch: { prompt: 'fix the bug' }, model: 'm1', cwd: '/w' } })
    expect(parseCodeLaunch([])).toEqual({ ok: true, start: { launch: {} } })
  })
  test('--resume carries an optional prompt and refuses --model / --cwd', () => {
    expect(parseCodeLaunch(['--resume', 'ses_1', 'go on'])).toEqual({ ok: true, start: { launch: { resume: 'ses_1', prompt: 'go on' } } })
    expect(parseCodeLaunch(['--resume', 'ses_1', '--model', 'x'])).toMatchObject({ ok: false })
    expect(parseCodeLaunch(['--resume', 'ses_1', '--cwd', '/x'])).toMatchObject({ ok: false })
  })
  test('refusals in words: a flag with no value, an unknown flag', () => {
    expect(parseCodeLaunch(['--model'])).toEqual({ ok: false, message: 'agentop code: --model needs a value.' })
    expect(parseCodeLaunch(['--cwd'])).toEqual({ ok: false, message: 'agentop code: --cwd needs a directory.' })
    expect(parseCodeLaunch(['--resume'])).toEqual({ ok: false, message: 'agentop code: --resume needs a session id.' })
    expect(parseCodeLaunch(['--nope'])).toEqual({ ok: false, message: 'agentop code: unknown flag "--nope".' })
  })
})
