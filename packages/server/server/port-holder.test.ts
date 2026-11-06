import { expect, test } from 'bun:test'
import { parseLsofHolders, parseSsHolders, portHeldSentence, portOfListenError } from './port-holder'

test('lsof -F output: the listener is named first, a connected socket after it', () => {
  const raw = 'p812\ncrapportd\nf9\nTST=ESTABLISHED\np4021\ncagentop\nf12\nTST=LISTEN\n'
  expect(parseLsofHolders(raw)).toEqual([
    { pid: 4021, command: 'agentop', listening: true },
    { pid: 812, command: 'rapportd', listening: false },
  ])
  expect(parseLsofHolders('')).toEqual([])
})

test('ss -p output names every process on the line', () => {
  const raw = 'ESTAB 0 0 127.0.0.1:28191 127.0.0.1:443 users:(("curl",pid=77,fd=5))\n' +
    'LISTEN 0 511 0.0.0.0:28191 0.0.0.0:* users:(("python3",pid=12,fd=3))\n'
  expect(parseSsHolders(raw)).toEqual([
    { command: 'python3', pid: 12, listening: true },
    { command: 'curl', pid: 77, listening: false },
  ])
})

test('the refusal names agentop only when the holder IS agentop, and says when it cannot tell', () => {
  expect(portHeldSentence(47291, { pid: 9, command: 'agentop', listening: true })).toBe('Port 47291 is already in use by another agentop server (pid 9)')
  expect(portHeldSentence(49191, { pid: 812, command: 'rapportd', listening: false })).toBe('Port 49191 is already in use by rapportd (pid 812), not an agentop server')
  expect(portHeldSentence(49191, null)).toContain('no process on this machine is named as holding it')
  expect(portHeldSentence(49191, undefined)).toContain('could not ask the system')
  for (const s of [portHeldSentence(1, null), portHeldSentence(1, undefined)]) expect(s).not.toContain('agentop server')
})

test('the port comes from Bun\'s own error, so a WEB_PORT failure is not reported as PORT', () => {
  expect(portOfListenError('Failed to start server. Is port 47292 in use?', 47291)).toBe(47292)
  expect(portOfListenError('listen EADDRINUSE: address already in use :::28191', 1)).toBe(28191)
  expect(portOfListenError('boom', 47291)).toBe(47291)
})
