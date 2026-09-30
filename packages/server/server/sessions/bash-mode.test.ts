import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { pendingEchoes } from '@agentistics/core'
import { MAX_SHELL_OUTPUT, cleanShellText, parseBashInput, parseBashOutput } from './bash-mode'
import { forgetChatTailContent, readChatWindow, readRecentChatTurns } from './chat-tail'

/*
 * THE FIXTURE IS THE MEASURED PAIR, byte for byte in shape: copied from a real transcript on this
 * machine (2026-09-30), the one behind the owner's report — `!agentop upgrade` sent from the
 * composer. Only the ids are shortened.
 */
const INPUT = {
  parentUuid: 'p-0', isSidechain: false, promptId: 'pr-1', type: 'user',
  message: { role: 'user', content: '<bash-input>agentop upgrade</bash-input>' },
  uuid: 'in-1', timestamp: '2026-09-30T19:49:43.439Z', userType: 'external',
}
const OUTPUT = {
  parentUuid: 'in-1', isSidechain: false, promptId: 'pr-1', type: 'user',
  message: {
    role: 'user',
    content: '<bash-stdout>Checking for updates...\n\n  \x1b[2mCurrent:\x1b[0m \x1b[97mv2.81.1\x1b[0m\n'
      + '  \x1b[2mLatest: \x1b[0m \x1b[92m\x1b[1mv2.82.0\x1b[0m\n\n'
      + '\x1b[92m\x1b[1mDone — now running v2.82.0.\x1b[0m</bash-stdout><bash-stderr></bash-stderr>',
  },
  uuid: 'out-1', timestamp: '2026-09-30T19:49:52.000Z', userType: 'external',
}
const REPLY = {
  parentUuid: 'out-1', type: 'assistant', uuid: 'a-1', timestamp: '2026-09-30T19:50:10.000Z',
  message: { role: 'assistant', content: [{ type: 'text', text: 'A atualização funcionou.' }] },
}
const jsonl = (...entries: unknown[]) => entries.map(e => JSON.stringify(e)).join('\n') + '\n'

describe('parseBashInput / parseBashOutput', () => {
  test('reads the command, trimmed — the measured shape has a leading space sometimes', () => {
    expect(parseBashInput('<bash-input>agentop upgrade</bash-input>')).toBe('agentop upgrade')
    expect(parseBashInput('<bash-input> pwd</bash-input>')).toBe('pwd')
    expect(parseBashInput('<bash-input>  </bash-input>')).toBeNull()
    expect(parseBashInput('run <bash-input>x</bash-input>')).toBeNull()
  })

  test('reads both streams and strips the colours the CLI printed', () => {
    const out = parseBashOutput(OUTPUT.message.content)!
    expect(out.stdout).toBe('Checking for updates...\n\n  Current: v2.81.1\n  Latest:  v2.82.0\n\nDone — now running v2.82.0.')
    expect(out.stderr).toBe('')
    expect(out.truncated).toBeUndefined()
  })

  test('stderr-only, as measured for a command that failed', () => {
    const out = parseBashOutput('<bash-stdout></bash-stdout><bash-stderr>/bin/bash: line 1: LS: command not found\n</bash-stderr>')!
    expect(out).toEqual({ stdout: '', stderr: '/bin/bash: line 1: LS: command not found' })
  })

  test('keeps the END of an oversized stream and says it was cut', () => {
    const big = 'x'.repeat(MAX_SHELL_OUTPUT) + 'VERDICT'
    const out = parseBashOutput(`<bash-stdout>${big}</bash-stdout><bash-stderr></bash-stderr>`)!
    expect(out.stdout.endsWith('VERDICT')).toBe(true)
    expect(out.stdout.length).toBe(MAX_SHELL_OUTPUT)
    expect(out.truncated).toBe(true)
  })

  test('a progress redraw keeps its last frame', () => {
    expect(cleanShellText('10%\r50%\r100%\ndone')).toBe('100%\ndone')
  })

  test('anything else is not bash mode', () => {
    expect(parseBashOutput('<local-command-stdout>x</local-command-stdout>')).toBeNull()
    expect(parseBashOutput('hello')).toBeNull()
  })
})

describe('the chat reads a `!` command as EXECUTED', () => {
  let root: string
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'bash-mode-')); forgetChatTailContent() })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  test('one turn: the `!line`, with its output — and no separate "command output" note', async () => {
    const file = join(root, 't.jsonl')
    await writeFile(file, jsonl(INPUT, OUTPUT, REPLY))
    const { turns } = await readChatWindow(file)
    expect(turns.map(t => t.system ?? t.text)).toEqual(['!agentop upgrade', 'A atualização funcionou.'])
    const run = turns[0]!
    expect(run.role).toBe('user')
    expect(run.at).toBe(INPUT.timestamp)
    expect(run.shell).toMatchObject({ command: 'agentop upgrade', summary: 'agentop upgrade', running: false })
    expect(run.shell!.output!.stdout).toContain('Done — now running v2.82.0.')
  })

  test('the six-row tail reads it the same way', async () => {
    const file = join(root, 't.jsonl')
    await writeFile(file, jsonl(INPUT, OUTPUT, REPLY))
    const turns = await readRecentChatTurns(file)
    expect(turns[0]!.text).toBe('!agentop upgrade')
    expect(turns[0]!.shell?.output?.stdout).toContain('v2.82.0')
    expect(turns.some(t => t.system === 'command output')).toBe(false)
  })

  test('the newest entry with no output yet is still RUNNING', async () => {
    const file = join(root, 't.jsonl')
    await writeFile(file, jsonl(INPUT))
    const { turns } = await readChatWindow(file)
    expect(turns[0]!.shell).toEqual({ command: 'agentop upgrade', summary: 'agentop upgrade', running: true })
  })

  test('an output whose input is outside the file keeps its note', async () => {
    const file = join(root, 't.jsonl')
    await writeFile(file, jsonl(OUTPUT, REPLY))
    const { turns } = await readChatWindow(file)
    expect(turns[0]!.system).toBe('command output')
  })

  test('a meta entry is never read as the person running a command', async () => {
    const file = join(root, 't.jsonl')
    await writeFile(file, jsonl({ ...INPUT, isMeta: true }))
    const { turns } = await readChatWindow(file)
    expect(turns[0]!.shell).toBeUndefined()
    expect(turns[0]!.system).toBeDefined()
  })

  test('the composer\'s echo — exactly what was sent — reconciles against the stored turn', async () => {
    const file = join(root, 't.jsonl')
    await writeFile(file, jsonl(INPUT, OUTPUT, REPLY))
    const { turns } = await readChatWindow(file)
    const userTurns = turns.filter(t => t.role === 'user').map(t => t.text)
    expect(pendingEchoes(['!agentop upgrade'], userTurns)).toEqual([])
    // A short one retires by equality, which is now possible because the `!` is kept.
    expect(pendingEchoes(['!ls'], ['!ls'])).toEqual([])
  })
})
