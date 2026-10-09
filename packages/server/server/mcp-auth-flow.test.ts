import { describe, expect, test } from 'bun:test'
import {
  AUTH_TIMEOUT_MS, advance, cancelled, exitCodeOf, extractAuthUrl, failureText, failureTail, newFlow, settle,
  validRedirectPaste,
} from './mcp-auth-flow'

// Captured from `claude mcp login figma --no-browser` in a tmux pane (claude 2.1.295), `-J` joined.
const CLAUDE_PANE = `Starting authentication for "figma"…
Visit this URL to authorize:
  https://www.figma.com/oauth/mcp?response_type=code&client_id=ROo1Du3lGkqSMzxFe88IZG&code_challenge=dezK62WFwL71QzMszI5Ya6V3EKIBe10FQDCTJY47XJk&code_challenge_method=S256&redirect_uri=http%3A%2F%2Flocalhost%3A49393%2Fcallback&state=OwaB69-vrkA5wesAYipweMLWEHfErWKPnxK8wodXsIA&scope=mcp%3Aconnect&resource=https%3A%2F%2Fmcp.figma.com%2Fmcp

Waiting for authorization… (^C to cancel)
Or paste the redirect URL here:
`

const fresh = () => newFlow({ id: 'f1', harness: 'claude', server: 'figma', pasteBack: true, now: 1000 })

describe('reads off the screen', () => {
  test('the authorisation URL is whole (the pane was joined) and nothing else', () => {
    const u = extractAuthUrl(CLAUDE_PANE)!
    expect(u.startsWith('https://www.figma.com/oauth/mcp?')).toBe(true)
    expect(u.endsWith('resource=https%3A%2F%2Fmcp.figma.com%2Fmcp')).toBe(true)
  })
  test('codex prints the URL after a sentence ending in a colon', () => {
    expect(extractAuthUrl('Authorize `figma` by opening this URL in your browser:\nhttps://x.example/a?b=1\n')).toBe('https://x.example/a?b=1')
  })
  test('no URL yet is null', () => { expect(extractAuthUrl('Starting authentication for "figma"…')).toBeNull() })
  test('exit marker', () => {
    expect(exitCodeOf('...\n[agentop-exit:0]\n')).toBe(0)
    expect(exitCodeOf('[agentop-exit:12]')).toBe(12)
    expect(exitCodeOf(CLAUDE_PANE)).toBeNull()
  })
  test('a failure tail never carries a URL (it holds the OAuth state) or the marker', () => {
    const t = failureTail(`${CLAUDE_PANE}\nCouldn't complete authentication: denied\n[agentop-exit:1]`)
    expect(t).toContain('denied')
    expect(t).not.toContain('http')
    expect(t).not.toContain('agentop-exit')
  })
})

describe('the redirect paste is typed into a process, so it is narrow', () => {
  test('a loopback callback with a code is accepted', () => {
    expect(validRedirectPaste('http://localhost:49393/callback?code=abc&state=xyz')).toBe(true)
    expect(validRedirectPaste('http://127.0.0.1:38391/callback?error=access_denied')).toBe(true)
  })
  test('everything else is refused', () => {
    expect(validRedirectPaste('https://evil.example/callback?code=abc')).toBe(false)
    expect(validRedirectPaste('http://localhost:1/callback')).toBe(false)
    expect(validRedirectPaste('rm -rf ~')).toBe(false)
    expect(validRedirectPaste('http://localhost:1/c?code=a\nrm -rf ~')).toBe(false)
    expect(validRedirectPaste('')).toBe(false)
    expect(validRedirectPaste(`http://localhost:1/c?code=${'a'.repeat(5000)}`)).toBe(false)
  })
})

describe('the state machine', () => {
  test('starting -> awaiting once the URL shows, and stays there while the CLI waits', () => {
    let f = advance(fresh(), { now: 2000, capture: 'Starting authentication…' })
    expect(f.phase).toBe('starting')
    f = advance(f, { now: 3000, capture: CLAUDE_PANE })
    expect(f.phase).toBe('awaiting')
    expect(f.url).toContain('figma.com/oauth')
    expect(advance(f, { now: 9000, capture: CLAUDE_PANE })).toBe(f)
  })
  test('exit 0 goes to finishing; the harness list then decides', () => {
    const awaiting = advance(fresh(), { now: 2000, capture: CLAUDE_PANE })
    const fin = advance(awaiting, { now: 4000, capture: `${CLAUDE_PANE}\nAuthentication successful\n[agentop-exit:0]` })
    expect(fin.phase).toBe('finishing')
    expect(settle(fin, 'connected', 5000)).toMatchObject({ phase: 'connected', verified: true, endedAt: 5000 })
    expect(settle(fin, 'authenticated', 5000)).toMatchObject({ phase: 'connected', verified: true })
    // a list that cannot say: the exit code is all there is, and the flow says it was not verified
    expect(settle(fin, null, 5000)).toMatchObject({ phase: 'connected', verified: false })
    // exit 0 but the harness still says it needs auth: NOT connected
    expect(settle(fin, 'needs-auth', 5000)).toMatchObject({ phase: 'failed', failure: 'still-needs-auth' })
  })
  test('a non-zero exit fails with the CLI words', () => {
    const f = advance(fresh(), { now: 2000, capture: 'Authentication failed: access_denied\n[agentop-exit:1]' })
    expect(f).toMatchObject({ phase: 'failed', failure: 'exit-nonzero' })
    expect(f.tail).toContain('access_denied')
  })
  test('the pane vanishing, and the timeout', () => {
    expect(advance(fresh(), { now: 2000, capture: null })).toMatchObject({ phase: 'failed', failure: 'pane-gone' })
    expect(advance(fresh(), { now: 1000 + AUTH_TIMEOUT_MS + 1, capture: 'waiting' })).toMatchObject({ phase: 'failed', failure: 'timeout' })
  })
  test('terminal phases are final; cancel does not reopen a finished flow', () => {
    const done = settle(advance(fresh(), { now: 2, capture: '[agentop-exit:0]' }), 'connected', 3)
    expect(advance(done, { now: 9, capture: null })).toBe(done)
    expect(cancelled(done, 10)).toBe(done)
    expect(cancelled(fresh(), 10)).toMatchObject({ phase: 'cancelled', endedAt: 10 })
  })
  test('sentences exist in both languages and carry the tail', () => {
    for (const f of ['pane-gone', 'exit-nonzero', 'timeout', 'still-needs-auth', 'no-tmux', 'no-cli', 'spawn-failed'] as const) {
      expect(failureText(f, 'pt').length).toBeGreaterThan(10)
      expect(failureText(f, 'en')).not.toBe(failureText(f, 'pt'))
    }
    expect(failureText('exit-nonzero', 'en', 'denied')).toContain('denied')
  })
})
