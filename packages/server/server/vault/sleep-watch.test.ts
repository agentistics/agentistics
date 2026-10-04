import { describe, expect, test } from 'bun:test'
import { WINDOWS_WATCH_SCRIPT, lockSignal, windowsLockSignal } from './sleep-watch'

describe('windowsLockSignal — what the WSL→PowerShell watcher says', () => {
  test('Win+L, logoff, user switch and remote disconnect are a screen lock; suspend is sleep', () => {
    for (const w of ['LOCK', 'LOGOFF', 'USER-SWITCH', 'REMOTE-DISCONNECT']) expect(windowsLockSignal(w + '\r')).toBe('screen-lock')
    expect(windowsLockSignal('SUSPEND')).toBe('sleep')
  })
  test('READY, blanks and noise lock nothing', () => {
    for (const w of ['READY', '', 'UNLOCK', 'lock']) expect(windowsLockSignal(w)).toBeNull()
  })
  test('the script prints exactly the words the parser knows', () => {
    for (const w of ['LOCK', 'LOGOFF', 'USER-SWITCH', 'REMOTE-DISCONNECT', 'SUSPEND']) expect(WINDOWS_WATCH_SCRIPT).toContain(`'${w}'`)
  })
  test('the Linux parser is unchanged', () => {
    expect(lockSignal('... org.freedesktop.login1.Manager.PrepareForSleep (true,)')).toBe('sleep')
  })
})
