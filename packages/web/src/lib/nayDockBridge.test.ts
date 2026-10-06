import { describe, expect, test } from 'bun:test'
import { undockMenuEntry, withUndockEntry } from './nayDockBridge'
import { lockedPhoneBox } from './phoneVault'

describe('Nay dock bridge', () => {
  test('provides the undock entry in both languages', () => {
    expect(undockMenuEntry(true).label).toBe('Abrir desacoplada')
    expect(undockMenuEntry(false).label).toBe('Open undocked')
    expect(withUndockEntry([{ action: 'rename', label: 'Rename', enabled: true }], false)[1]?.action).toBe('agentistics:nay-undock-session')
    expect(withUndockEntry([{ action: 'rename', label: 'Rename', enabled: true }], false, false)).toHaveLength(1)
  })

  test('shows the locked phone registration box only when needed', () => {
    expect(lockedPhoneBox({ loopback: false, passkeys: 0, devices: [], secure: true })).toBe('register')
    expect(lockedPhoneBox({ loopback: false, passkeys: 0, devices: [], secure: false })).toBe('insecure')
    expect(lockedPhoneBox({ loopback: false, passkeys: 1, devices: [], secure: true })).toBe('none')
    expect(lockedPhoneBox({ loopback: false, passkeys: 0, devices: ['dev-1'], secure: true })).toBe('none')
  })
})
