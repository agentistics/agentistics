import { describe, expect, test } from 'bun:test'
import {
  TRANSCRIPT_SOURCES, grepArgv, conversationIdFrom, parseGrepOutput,
} from './transcript-search'

describe('grepArgv', () => {
  test('passes the query as an ARGUMENT, never through a shell', () => {
    const argv = grepArgv('docker', '/root', '*.jsonl')
    expect(argv[0]).toBe('grep')
    expect(argv).toContain('docker')
    // No shell means no string to be parsed: every element is its own argv slot.
    expect(argv.every(a => typeof a === 'string')).toBe(true)
  })

  test('terminates the flags with `--`, so a query that looks like a flag stays a query', () => {
    const argv = grepArgv('-r', '/root', '*.jsonl')
    const dashdash = argv.indexOf('--')
    expect(dashdash).toBeGreaterThan(-1)
    expect(argv.indexOf('-r')).toBeGreaterThan(dashdash)
  })

  test('a query carrying shell metacharacters is one literal argument', () => {
    const argv = grepArgv('; rm -rf /', '/root', '*.jsonl')
    expect(argv).toContain('; rm -rf /')
  })

  test('searches case-insensitively and stops at the first hit per file', () => {
    const argv = grepArgv('docker', '/root', '*.jsonl')
    // -l stops reading a file once it matches; -i is what makes the search case-blind.
    expect(argv.some(a => a.includes('l') && a.startsWith('-'))).toBe(true)
    expect(argv.some(a => a.includes('i') && a.startsWith('-'))).toBe(true)
  })

  test('scopes the walk to the harness file pattern and root it was given', () => {
    const argv = grepArgv('x', '/my/root', 'wire.jsonl')
    expect(argv).toContain('--include=wire.jsonl')
    expect(argv).toContain('/my/root')
  })
})

describe('conversationIdFrom', () => {
  test('claude — the file IS the conversation id', () => {
    expect(conversationIdFrom(
      'claude',
      '/home/u/.claude/projects/-home-u-proj/a1fa25c2-1f0f-4894-a359-81fbc0a665b1.jsonl',
      '/home/u/.claude/projects',
    )).toBe('a1fa25c2-1f0f-4894-a359-81fbc0a665b1')
  })

  test('codex — the id trails a timestamp in the file name', () => {
    expect(conversationIdFrom(
      'codex',
      '/home/u/.codex/sessions/2026/07/27/rollout-2026-07-27T19-02-04-019fa599-71b2-7012-acfb-cb5f6387f6b6.jsonl',
      '/home/u/.codex/sessions',
    )).toBe('019fa599-71b2-7012-acfb-cb5f6387f6b6')
  })

  test('copilot — the id is the directory holding events.jsonl', () => {
    expect(conversationIdFrom(
      'copilot',
      '/home/u/.copilot/session-state/155dfe66-173e-4397-b5e9-9f7062d456ba/events.jsonl',
      '/home/u/.copilot/session-state',
    )).toBe('155dfe66-173e-4397-b5e9-9f7062d456ba')
  })

  test('kimi — every agent of a session folds into the session directory', () => {
    expect(conversationIdFrom(
      'kimi',
      '/home/u/.kimi-code/sessions/wd_x/session_3000ec80-fcff-4f52-b523-b2e40b2e8e34/agents/main/wire.jsonl',
      '/home/u/.kimi-code/sessions',
    )).toBe('3000ec80-fcff-4f52-b523-b2e40b2e8e34')
  })

  test('antigravity — the id is the brain/ child, not the logs directory', () => {
    expect(conversationIdFrom(
      'antigravity',
      '/home/u/.gemini/antigravity-cli/brain/4b6ce613-e171-4cae-ad75-326be6ccb69c/.system_generated/logs/transcript_full.jsonl',
      '/home/u/.gemini/antigravity-cli/brain',
    )).toBe('4b6ce613-e171-4cae-ad75-326be6ccb69c')
  })

  test('gemini — the id is synthetic, project directory AND file, as the adapter builds it', () => {
    expect(conversationIdFrom(
      'gemini',
      '/home/u/.gemini/tmp/ads-propostas/chats/session-2026-07-27T13-07-dce86b69.jsonl',
      '/home/u/.gemini/tmp',
    )).toBe('ads-propostas/session-2026-07-27T13-07-dce86b69')
  })

  test('a path that does not fit the harness shape yields nothing, never a guess', () => {
    expect(conversationIdFrom('copilot', '/home/u/.copilot/session-state/events.jsonl', '/home/u/.copilot/session-state')).toBeNull()
    expect(conversationIdFrom('codex', '/root/not-a-rollout.jsonl', '/root')).toBeNull()
  })
})

describe('parseGrepOutput', () => {
  test('reads NUL-separated paths, which is what survives a space in a directory name', () => {
    const out = [
      '/r/-home-u-my proj/aaaaaaaa-1111-2222-3333-444444444444.jsonl',
      '/r/-home-u-other/bbbbbbbb-1111-2222-3333-444444444444.jsonl',
    ].join('\0') + '\0'
    expect(parseGrepOutput('claude', out, '/r')).toEqual([
      'aaaaaaaa-1111-2222-3333-444444444444',
      'bbbbbbbb-1111-2222-3333-444444444444',
    ])
  })

  test('empty output is an empty result, not a failure', () => {
    expect(parseGrepOutput('claude', '', '/r')).toEqual([])
  })

  test('the same conversation reached through two files is reported once', () => {
    const out = [
      '/r/w/session_3000ec80-fcff-4f52-b523-b2e40b2e8e34/agents/main/wire.jsonl',
      '/r/w/session_3000ec80-fcff-4f52-b523-b2e40b2e8e34/agents/sub/wire.jsonl',
    ].join('\0')
    expect(parseGrepOutput('kimi', out, '/r')).toEqual(['3000ec80-fcff-4f52-b523-b2e40b2e8e34'])
  })

  test('a path it cannot resolve is dropped, never emitted as a partial id', () => {
    const out = ['/r/garbage.txt', '/r/-p/cccccccc-1111-2222-3333-444444444444.jsonl'].join('\0')
    expect(parseGrepOutput('claude', out, '/r')).toEqual(['cccccccc-1111-2222-3333-444444444444'])
  })
})

describe('TRANSCRIPT_SOURCES', () => {
  test('every harness is accounted for — a new one cannot be forgotten silently', () => {
    const ids = ['claude', 'codex', 'gemini', 'copilot', 'antigravity', 'kimi', 'opencode'] as const
    for (const id of ids) expect(TRANSCRIPT_SOURCES[id]).toBeDefined()
  })

  test('each source states the file pattern it walks', () => {
    for (const src of Object.values(TRANSCRIPT_SOURCES)) {
      if (src) expect(src.include.length).toBeGreaterThan(0)
    }
  })
})
