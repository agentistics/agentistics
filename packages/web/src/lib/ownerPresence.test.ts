import { expect, test } from 'bun:test'
import { reportOpenSession, presenceActive } from './ownerPresence'
test('a visible but unfocused browser never reports owner presence', () => {
  expect(presenceActive('visible', true)).toBe(true)
  expect(presenceActive('hidden', true)).toBe(false)
  expect(presenceActive('visible', false)).toBe(false)
})

test('Nay can update its open session in a partial DOM without starting presence IO', () => {
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document')
  Object.defineProperty(globalThis, 'window', { value: new EventTarget(), configurable: true })
  Reflect.deleteProperty(globalThis, 'document')
  try { expect(() => reportOpenSession('session')).not.toThrow() }
  finally {
    if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor)
    else Reflect.deleteProperty(globalThis, 'window')
    if (documentDescriptor) Object.defineProperty(globalThis, 'document', documentDescriptor)
  }
})
