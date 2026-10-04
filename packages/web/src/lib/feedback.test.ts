import { describe, expect, test } from 'bun:test'
import {
  buildBody, buildFeedbackTarget, browserOf, canSend, collectInfo, includedInfo, INFO_KEYS, MAX_URL_LENGTH, osOf,
  type FeedbackDraft,
} from './feedback'

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.58 Safari/537.36'
const facts = { version: '2.103.1', engine: '1.4.0', userAgent: UA, harnesses: ['claude', 'codex'] }
const bug: FeedbackDraft = { kind: 'bug', title: 'Crash on open', description: 'It broke' }

describe('collectInfo — the closed list of what may travel', () => {
  test('one line per fact, in INFO_KEYS order, in the language asked', () => {
    const l = collectInfo(facts, true)
    expect(l.map(x => x.key)).toEqual([...INFO_KEYS])
    expect(l[0]).toEqual({ key: 'version', label: 'Versão do agentop', value: '2.103.1' })
    expect(l.find(x => x.key === 'os')?.value).toBe('Linux · x64')
    expect(l.find(x => x.key === 'browser')?.value).toBe('Chrome 130')
    expect(l.find(x => x.key === 'harnesses')?.value).toBe('claude, codex')
  })
  test('a fact we do not have is absent, never blank', () => {
    expect(collectInfo({ version: '1.0.0' }, false).map(x => x.key)).toEqual(['version'])
  })
  test('the browser line is family + major only, never the full user agent', () => {
    expect(browserOf(UA)).toBe('Chrome 130')
    expect(collectInfo(facts, false).some(l => l.value.includes('AppleWebKit'))).toBe(false)
  })
  test('harness entries that are not plain names are dropped (a path or repo cannot ride along)', () => {
    const l = collectInfo({ harnesses: ['claude', '/home/me/secret', 'org/repo', 'me@mail.com'] }, false)
    expect(l.find(x => x.key === 'harnesses')?.value).toBe('claude')
  })
  test('facts outside the closed shape are ignored', () => {
    const l = collectInfo({ ...facts, token: 'sk-123', path: '/home/me', email: 'a@b.c' } as never, false)
    expect(JSON.stringify(l)).not.toMatch(/sk-123|\/home\/me|a@b\.c/)
  })
  test('osOf prefers the stated platform', () => { expect(osOf(UA, 'macOS', 'arm64')).toBe('macOS · arm64') })
})

describe('unticking a line removes exactly it from the body', () => {
  test('each key, one at a time', () => {
    const lines = collectInfo(facts, false)
    for (const l of lines) {
      const body = buildBody(bug, includedInfo(lines, new Set([l.key])), false)
      expect(body).not.toContain(`**${l.label}:**`)
      for (const other of lines.filter(o => o.key !== l.key)) expect(body).toContain(`**${other.label}:** ${other.value}`)
    }
  })
  test('with everything unticked there is no info block at all', () => {
    const lines = collectInfo(facts, false)
    expect(buildBody(bug, includedInfo(lines, new Set(INFO_KEYS)), false)).not.toContain('Included information')
  })
})

describe('buildFeedbackTarget', () => {
  const lines = collectInfo(facts, false)
  test('a bug is an issue labelled bug on the public repository, encoded', () => {
    const t = buildFeedbackTarget({ ...bug, title: 'a & b?' }, lines, false)
    expect(t.clipboard).toBeNull()
    expect(t.url.startsWith('https://github.com/agentistics/agentistics/issues/new?labels=bug&title=a%20%26%20b%3F&body=')).toBe(true)
  })
  test('a suggestion is an issue labelled suggestion', () => {
    expect(buildFeedbackTarget({ ...bug, kind: 'suggestion' }, lines, false).url).toContain('labels=suggestion')
  })
  test('body carries the description and the included info, nothing else', () => {
    const body = decodeURIComponent(buildFeedbackTarget(bug, lines, false).url.split('&body=')[1]!)
    expect(body).toContain('It broke')
    expect(body).toContain('**agentop version:** 2.103.1')
  })
  test('too long for a URL: the body goes to the clipboard and the URL carries a pointer', () => {
    const t = buildFeedbackTarget({ ...bug, description: 'x'.repeat(20_000) }, lines, false)
    expect(t.url.length).toBeLessThanOrEqual(MAX_URL_LENGTH)
    expect(t.clipboard).toContain('x'.repeat(100))
    expect(decodeURIComponent(t.url)).toContain('did not fit in the link')
  })
  test('the limit is the parameter', () => {
    expect(buildFeedbackTarget(bug, lines, false, 50).clipboard).not.toBeNull()
  })
  test('canSend needs a title', () => {
    expect(canSend({ ...bug, title: '  ' })).toBe(false)
    expect(canSend(bug)).toBe(true)
  })
})
