import { expect, test } from 'bun:test'
import { HARNESS_ORDER } from '@agentistics/core'
import { ALL_DRIVERS, chatHarnessStatus } from './index'
import { availableHarnesses } from '../sessions/harness-available'
import { HARNESS_INSTALLERS } from '../sessions/harness-install-plan'

test('chat settings retain only usable chat drivers, while catalog shares fleet installation detection', async () => {
  const chat = await chatHarnessStatus()
  expect(chat.map(h => h.id)).toEqual(ALL_DRIVERS.map(d => d.id))
  const catalog = await chatHarnessStatus(true)
  expect(catalog.map(h => h.id)).toEqual(HARNESS_ORDER)
  const detection = availableHarnesses()
  for (const h of catalog) {
    expect(h.installed).toBe(!detection.blind && detection.ids.includes(h.id))
    expect(h.canInstall).toBe(Object.hasOwn(HARNESS_INSTALLERS, h.id))
    if (!h.canInstall) expect(h.setup.docUrl).toMatch(/^https:\/\//)
    if (!ALL_DRIVERS.some(d => d.id === h.id)) expect(h.ready).toBe(false)
  }
})
