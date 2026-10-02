/**
 * The Windows Hello bridge as it actually runs: Windows PowerShell 5.1, from WSL or natively.
 *
 * Found on the owner's machine (WSL2, Windows 11, PowerShell 5.1.26100), 2026-10-02: "turn on presence"
 * failed with `presence-unavailable: System.Management.Automation.PSInvalidCastException`, and that raw
 * .NET name was what the screen showed. Reproduced without a gesture: `CryptographicBuffer` hands back
 * an `IBuffer` as a bare `System.__ComObject`, and PowerShell 5.1's binder cannot QueryInterface it into
 * `Windows.Storage.Streams.IBuffer` — not even with the projection loaded — so `RequestSignAsync`'s
 * signature could never be read back (and `CopyToByteArray(<that object>)` throws the very cast).
 * These tests pin the shape of the fix and the rule that a bridge's raw text never becomes a sentence.
 */
import { describe, expect, it } from 'bun:test'
import { helloProtector, HELLO_SCRIPT } from './hello'
import { WSL_INTEROP, WSL_POWERSHELL } from './dpapi'
import { parseBridgeError, presenceSentence, PRESENCE_DETAILS } from './presence'
import { bytes, text, type ProtectorIo, type RunResult } from './types'

const CAST = 'PRESENCE-ERROR unavailable bridge-failed System.Management.Automation.PSInvalidCastException 0x80004002'

describe('the Hello script — IBuffer never crosses the PowerShell binder as a COM object', () => {
  it('feeds the challenge as a MANAGED buffer (WindowsRuntimeBuffer), never CryptographicBuffer', () => {
    expect(HELLO_SCRIPT).toContain('[System.Runtime.InteropServices.WindowsRuntime.WindowsRuntimeBufferExtensions]::AsBuffer(')
    expect(HELLO_SCRIPT).not.toContain('CryptographicBuffer')
  })
  it('reads the signature back through a reflected ToArray(IBuffer), so the CLR does the QueryInterface', () => {
    expect(HELLO_SCRIPT).toContain('$IB=[Windows.Storage.Streams.IBuffer,Windows.Storage.Streams,ContentType=WindowsRuntime]')
    expect(HELLO_SCRIPT).toContain('$toArr=[System.Runtime.InteropServices.WindowsRuntime.WindowsRuntimeBufferExtensions].GetMethod("ToArray",[type[]]@($IB))')
    expect(HELLO_SCRIPT).toContain('[byte[]]$toArr.Invoke($null,[object[]]@($s.Result))')
  })
  it('a delete of a credential that is already gone (NTE_NO_KEY) is done, not a failure', () => {
    expect(HELLO_SCRIPT).toContain('0x8009000D')
  })
  it('every failure the script can emit carries a detail KEY from the closed list', () => {
    const keys = [...HELLO_SCRIPT.matchAll(/Fail "[a-z]+" "([a-z-]+)"/g)].map(m => m[1]!)
    expect(keys.length).toBeGreaterThan(5)
    for (const k of keys) expect(PRESENCE_DETAILS as readonly string[]).toContain(k)
    // The catch-all names the exception TYPE and HRESULT only (for the log), never its message.
    expect(HELLO_SCRIPT).toContain('Fail "unavailable" "bridge-failed" ($x.GetType().FullName + " 0x" + $x.HResult.ToString("X8"))')
  })
})

describe('stderr → code + detail key; the raw text goes to the log only', () => {
  it('the owner\'s cast error becomes presence-unavailable / bridge-failed, raw kept for the log', () => {
    const e = parseBridgeError(CAST)
    expect(e.code).toBe('presence-unavailable')
    expect(e.detail).toBe('bridge-failed')
    expect(e.raw).toContain('PSInvalidCastException')
  })
  it('a detail outside the closed list is never passed on', () => {
    expect(parseBridgeError('PRESENCE-ERROR unavailable System.AggregateException').detail).toBe('bridge-failed')
    expect(parseBridgeError('PRESENCE-ERROR lost the credential was deleted').detail).toBe('bridge-failed')
    expect(parseBridgeError('powershell blew up: System.IO.FileNotFoundException').detail).toBe('bridge-failed')
    expect(parseBridgeError('PRESENCE-ERROR cancelled').detail).toBe('')
  })
  it('the Hello adapter logs the raw line and puts only the key in the reason', async () => {
    const logged: string[] = []
    const io: ProtectorIo = {
      async run(): Promise<RunResult> { return { code: 3, stdout: new Uint8Array(), stderr: CAST } },
      async readFile() { return bytes(JSON.stringify({ v: 1, challenge: 'AAAA', wrapped: 'AAAA' })) },
      async writeFile() {}, async removeFile() {}, async createExclusive() { return true },
      async firstExisting(c) { return c.find(x => x === WSL_INTEROP || x === WSL_POWERSHELL) ?? null },
      async which() { return null },
    }
    const p = helloProtector({ io, vaultDir: '/v', wsl: true, log: l => logged.push(l) })
    const u = await p.unwrap({ type: 'hello', createdAt: 'x' }, 'k1')
    expect(u.ok).toBe(false)
    expect(!u.ok && u.reason).toBe('presence-unavailable: bridge-failed')
    expect(logged.join('\n')).toContain('PSInvalidCastException')
    const w = await p.wrap(new Uint8Array(32), 'k1')
    expect(!w.ok && w.reason).toBe('presence-unavailable: bridge-failed')
    expect(text(bytes(logged.join(''))).length).toBeGreaterThan(0)
  })
})

describe('the sentence a person reads', () => {
  it('names the failure in words, in EN and PT, and never a .NET type', () => {
    for (const lang of ['en', 'pt'] as const) {
      const s = presenceSentence('presence-unavailable', lang, 'Windows Hello', 'presence-unavailable: bridge-failed')
      expect(s).not.toContain('bridge-failed')
      expect(s).not.toMatch(/System\./)
      expect(s).toContain('Windows Hello')
    }
    expect(presenceSentence('presence-unavailable', 'pt', 'o Windows Hello', 'presence-unavailable: bridge-failed')).toContain('ponte do Windows')
    expect(presenceSentence('presence-unavailable', 'en', 'Windows Hello', 'presence-unavailable: bridge-failed')).toContain('Windows bridge')
  })
  it('every detail key has an EN and a PT phrase', () => {
    for (const k of PRESENCE_DETAILS) {
      for (const lang of ['en', 'pt'] as const) {
        const s = presenceSentence('presence-unavailable', lang, 'X', `presence-unavailable: ${k}`)
        expect(s).not.toContain(k)
      }
    }
  })
  it('a raw .NET type that slipped into a reason anyway is not repeated to the person', () => {
    const s = presenceSentence('presence-unavailable', 'en', 'Windows Hello', 'presence-unavailable: System.Management.Automation.PSInvalidCastException')
    expect(s).not.toMatch(/System\./)
  })
})
