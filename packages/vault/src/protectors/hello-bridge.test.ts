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
import { parseBridgeError, presenceSentence, PRESENCE_DETAILS, PRESENCE_GESTURES, setGestureListener } from './presence'
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

describe('the gesture count the page states is the count the bridge raises (owner 2026-10-02)', () => {
  // A fake PowerShell that answers every verb: create → ok, sign → a fixed signature.
  function okIo(calls: string[]): ProtectorIo {
    const files = new Map<string, Uint8Array>()
    return {
      async run(_p, _a, stdin): Promise<RunResult> {
        const verb = text(stdin ?? new Uint8Array()).split('\n')[0]!
        calls.push(verb)
        return { code: 0, stdout: bytes(verb === 'sign' ? Buffer.alloc(256, 7).toString('base64') : 'ok'), stderr: '' }
      },
      async readFile(f) { return files.get(f) ?? null },
      async writeFile(f, b) { files.set(f, b) }, async removeFile(f) { files.delete(f) }, async createExclusive() { return true },
      async firstExisting(c) { return c.find(x => x === WSL_INTEROP || x === WSL_POWERSHELL) ?? null },
      async which() { return null },
    }
  }
  it('device check 0, enrolment 2 (create + ONE sign), unlock 1 — the minimum the API allows (owner decision 2026-10-02)', async () => {
    expect(PRESENCE_GESTURES).toEqual({ probe: 0, enroll: 2, unlock: 1 })
    const calls: string[] = []
    let ticks = 0
    setGestureListener(() => { ticks++ })
    try {
      const p = helloProtector({ io: okIo(calls), vaultDir: '/v', wsl: true })
      expect((await p.probe()).ok).toBe(true)
      expect(ticks).toBe(PRESENCE_GESTURES.probe)
      expect(calls).toEqual(['check'])
      const w = await p.wrap(new Uint8Array(32).fill(1), 'k1')
      expect(w.ok).toBe(true)
      expect(ticks).toBe(PRESENCE_GESTURES.enroll)
      expect(calls.filter(c => c === 'create' || c === 'sign')).toEqual(['create', 'sign'])
      if (!w.ok) return
      const u = await p.unwrap(w.record, 'k1')
      expect(u.ok).toBe(true)
      expect(ticks).toBe(PRESENCE_GESTURES.enroll + PRESENCE_GESTURES.unlock)
      // delete/check raise no dialog and tick nothing
      await p.remove(w.record, 'k1')
      expect(ticks).toBe(PRESENCE_GESTURES.enroll + PRESENCE_GESTURES.unlock)
    } finally { setGestureListener(null) }
  })
  it('two-phase enrolment: derive takes the 2 prompts and writes nothing; sealHeld takes NONE, checks the held KEK opens it, then writes', async () => {
    const calls: string[] = []
    const io = okIo(calls)
    const written: string[] = []
    const w = io.writeFile.bind(io)
    io.writeFile = async (f, b) => { written.push(f); return w(f, b) }
    let ticks = 0
    setGestureListener(() => { ticks++ })
    try {
      const p = helloProtector({ io, vaultDir: '/v', wsl: true })
      const d = await p.derive!('k1')
      expect(d.ok).toBe(true)
      if (!d.ok) return
      expect(ticks).toBe(2)
      expect(written).toEqual([]) // nothing on disk until the LAST step
      const before = calls.length
      const dek = new Uint8Array(32).fill(9)
      const s = await p.sealHeld!(d.held, dek, 'k1')
      expect(s.ok).toBe(true)
      expect(calls.length).toBe(before) // no bridge call at all: no gesture
      expect(ticks).toBe(2)
      expect(written).toEqual(['/v/dek.hello'])
      if (!s.ok) return
      const u = await p.unwrap(s.record, 'k1') // the first real unlock: ONE sign, same key
      expect(u.ok && Buffer.from(u.dek).equals(Buffer.from(dek))).toBe(true)
      // A held key that is not 32 bytes (zeroed / damaged) is refused before anything is written.
      const bad = await p.sealHeld!({ kek: new Uint8Array(3), fields: d.held.fields }, dek, 'k1')
      expect(bad.ok).toBe(false)
      expect(written).toEqual(['/v/dek.hello'])
    } finally { setGestureListener(null) }
  })
  it('a failed or cancelled prompt does not count as one answered', async () => {
    let ticks = 0
    setGestureListener(() => { ticks++ })
    try {
      const io: ProtectorIo = { ...okIo([]), async run(): Promise<RunResult> { return { code: 3, stdout: new Uint8Array(), stderr: 'PRESENCE-ERROR cancelled' } } }
      expect((await helloProtector({ io, vaultDir: '/v', wsl: true }).wrap(new Uint8Array(32), 'k1')).ok).toBe(false)
      expect(ticks).toBe(0)
    } finally { setGestureListener(null) }
  })
})

describe('the Hello dialog opens IN FRONT (owner 2026-10-02: it opened minimized/behind every time)', () => {
  it('a topmost owner window takes the foreground through AttachThreadInput, never an ALT-key trick', () => {
    expect(HELLO_SCRIPT).toContain('function Front(){')
    expect(HELLO_SCRIPT).toContain('$F.TopMost=$true')
    expect(HELLO_SCRIPT).toContain('[Ag.W]::AttachThreadInput($me,$ft,$true)')
    expect(HELLO_SCRIPT).toContain('[void][Ag.W]::SetForegroundWindow($F.Handle)')
    expect(HELLO_SCRIPT).toContain('[void][Ag.W]::AttachThreadInput($me,$ft,$false)') // detached again
    expect(HELLO_SCRIPT).not.toContain('keybd_event')
    expect(HELLO_SCRIPT).not.toContain('GetConsoleWindow') // a WSL-started powershell has no console window to bring up
  })
  it('the owner window is the dialog\'s owner: ForWindow calls with its WindowId, plain calls only as the fallback', () => {
    expect(HELLO_SCRIPT).toContain('$w.Value=[uint64]$F.Handle.ToInt64()')
    expect(HELLO_SCRIPT).toContain('$KCM::RequestCreateForWindowAsync($wid,$name,$opt)')
    expect(HELLO_SCRIPT).toContain('$o.Credential.RequestSignForWindowAsync($wid,$buf)')
    expect(HELLO_SCRIPT).toContain('} else { $r=AwaitOp ($KCM::RequestCreateAsync($name,$opt))')
    expect(HELLO_SCRIPT).toContain('} else { $s=AwaitOp ($o.Credential.RequestSignAsync($buf))')
  })
  it('the foreground is never fatal, is raised only for the verbs that show a dialog, and the window keeps pumping', () => {
    expect(HELLO_SCRIPT).toMatch(/function Front\(\)\{ try \{ .* \} catch \{ return \$null \} \}/)
    expect(HELLO_SCRIPT.match(/\$wid=Front/g)?.length).toBe(2) // create + sign; check/delete raise nothing
    expect(HELLO_SCRIPT).toContain('[System.Windows.Forms.Application]::DoEvents() }; Start-Sleep -Milliseconds 30')
    expect(HELLO_SCRIPT).toContain('if ($sw.ElapsedMilliseconds -gt 60000) { Fail "timeout" "" "" }')
  })
})
