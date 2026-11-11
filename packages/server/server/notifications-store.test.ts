import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  readNotificationsFrom, addNotificationTo, markAllReadIn, dismissNotificationIn,
  clearNotificationsIn, listNotifications, MAX_ITEMS,
} from './notifications-store'

let dir = ''
let file = ''

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agentistics-notifications-'))
  file = join(dir, 'notifications.json')
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('reading', () => {
  test('a missing file is an empty history, not an error', async () => {
    expect(await readNotificationsFrom(file)).toEqual([])
  })

  test('a corrupt file degrades to empty instead of throwing', async () => {
    await writeFile(file, '{not json')
    expect(await readNotificationsFrom(file)).toEqual([])
  })

  test('entries missing required fields are dropped, valid ones kept', async () => {
    await writeFile(file, JSON.stringify({
      version: 1,
      items: [
        { id: 'ok', ts: 2, type: 'info', code: 'a', read: false },
        { id: 'no-ts', type: 'info' },
        null,
        'garbage',
      ],
    }))
    expect((await readNotificationsFrom(file)).map(n => n.id)).toEqual(['ok'])
  })

  test('newest first, regardless of the order on disk', async () => {
    await writeFile(file, JSON.stringify({
      version: 1,
      items: [
        { id: 'old', ts: 1, type: 'info', read: false },
        { id: 'new', ts: 9, type: 'info', read: false },
      ],
    }))
    expect((await readNotificationsFrom(file)).map(n => n.id)).toEqual(['new', 'old'])
  })
})

describe('adding', () => {
  test('a notification survives being written and read back', async () => {
    await addNotificationTo(file, { type: 'error', code: 'member.removed' })
    const items = await readNotificationsFrom(file)
    expect(items).toHaveLength(1)
    expect(items[0]!.code).toBe('member.removed')
    expect(items[0]!.read).toBe(false)
  })

  test('only code+meta are stored — never rendered text, so the language stays switchable', async () => {
    await addNotificationTo(file, { type: 'info', code: 'member.reconnected' })
    const raw = await Bun.file(file).text()
    expect(raw).not.toContain('Conectado à central')
    expect(raw).not.toContain('Connected to the central')
    expect(raw).toContain('member.reconnected')
  })

  test('a repeat of something already in the history updates it instead of adding a copy', async () => {
    // app.update_available re-fires on every page load of an outdated machine, from every device.
    await addNotificationTo(file, { type: 'info', code: 'app.update_available', meta: { version: '1.2.3' } })
    await markAllReadIn(file)
    const after = await addNotificationTo(file, { type: 'info', code: 'app.update_available', meta: { version: '1.2.3' } })
    expect(after).toHaveLength(1)
    // A real re-occurrence is still surfaced: the row goes back to unread.
    expect(after[0]!.read).toBe(false)
  })

  test('different meta is a different notification', async () => {
    await addNotificationTo(file, { type: 'info', code: 'app.update_available', meta: { version: '1.2.3' } })
    const after = await addNotificationTo(file, { type: 'info', code: 'app.update_available', meta: { version: '1.2.4' } })
    expect(after).toHaveLength(2)
  })

  test('a stable notification key updates progress in place', async () => {
    await addNotificationTo(file, { type: 'info', title: 'Loading', message: '42%', meta: { notificationKey: 'loading.startup', state: 'running' } })
    const after = await addNotificationTo(file, { type: 'success', title: 'Complete', message: 'Done', meta: { notificationKey: 'loading.startup', state: 'done' } })
    expect(after).toHaveLength(1)
    expect(after[0]).toMatchObject({ type: 'success', title: 'Complete', message: 'Done', meta: { state: 'done' } })
  })

  test('the history is capped so it cannot grow without limit', async () => {
    for (let i = 0; i < MAX_ITEMS + 15; i++) {
      await addNotificationTo(file, { type: 'info', code: `code-${i}` })
    }
    const items = await readNotificationsFrom(file)
    expect(items).toHaveLength(MAX_ITEMS)
    // The newest survive.
    expect(items[0]!.code).toBe(`code-${MAX_ITEMS + 14}`)
  })
})

describe('clearing', () => {
  test('dismissing one leaves the others', async () => {
    await addNotificationTo(file, { type: 'info', code: 'a' })
    await addNotificationTo(file, { type: 'info', code: 'b' })
    await addNotificationTo(file, { type: 'info', code: 'c' })
    const b = (await readNotificationsFrom(file)).find(n => n.code === 'b')!

    const after = await dismissNotificationIn(file, b.id)

    expect(after.map(n => n.code)).toEqual(['c', 'a'])
    expect((await readNotificationsFrom(file)).map(n => n.code)).toEqual(['c', 'a'])
  })

  test('dismissing an unknown id is a no-op — two devices may dismiss the same row', async () => {
    await addNotificationTo(file, { type: 'info', code: 'a' })
    const after = await dismissNotificationIn(file, 'does-not-exist')
    expect(after).toHaveLength(1)
  })

  test('clear-all empties the stored file', async () => {
    await addNotificationTo(file, { type: 'info', code: 'a' })
    await clearNotificationsIn(file)
    expect(await readNotificationsFrom(file)).toEqual([])
  })

  test('a cleared history stays cleared — nothing resurrects it', async () => {
    await addNotificationTo(file, { type: 'info', code: 'a' })
    await clearNotificationsIn(file)
    expect(await readNotificationsFrom(file)).toEqual([])
    expect(await readNotificationsFrom(file)).toEqual([])
  })

  test('mark-all-read persists', async () => {
    await addNotificationTo(file, { type: 'info', code: 'a' })
    await markAllReadIn(file)
    expect((await listNotifications(file))[0]!.read).toBe(true)
  })
})

describe('concurrency', () => {
  test('simultaneous adds all land — no read-modify-write loses one', async () => {
    await Promise.all(
      Array.from({ length: 12 }, (_, i) => addNotificationTo(file, { type: 'info', code: `c${i}` })),
    )
    expect(await readNotificationsFrom(file)).toHaveLength(12)
  })

  test('two devices dismissing different rows at the same time: both deletions stick', async () => {
    for (const code of ['a', 'b', 'c']) await addNotificationTo(file, { type: 'info', code })
    const items = await readNotificationsFrom(file)
    const a = items.find(n => n.code === 'a')!
    const b = items.find(n => n.code === 'b')!

    await Promise.all([dismissNotificationIn(file, a.id), dismissNotificationIn(file, b.id)])

    expect((await readNotificationsFrom(file)).map(n => n.code)).toEqual(['c'])
  })

  test('a clear racing an add leaves a consistent list, never a corrupt file', async () => {
    for (const code of ['a', 'b']) await addNotificationTo(file, { type: 'info', code })
    await Promise.all([clearNotificationsIn(file), addNotificationTo(file, { type: 'info', code: 'c' })])
    const items = await readNotificationsFrom(file)
    // Either order is acceptable; what must hold is that the file is readable and bounded.
    expect(items.length).toBeLessThanOrEqual(1)
  })
})

describe('a file written by an older version', () => {
  test('a row only the local user had read stays read; a per-account dismissal is not kept', async () => {
    await writeFile(file, JSON.stringify({
      version: 1,
      items: [
        { id: 'read-by-me', ts: 5, type: 'info', code: 'a', readBy: ['@local'], hiddenFor: [] },
        { id: 'unread', ts: 4, type: 'info', code: 'b', readBy: [], hiddenFor: [] },
        { id: 'dismissed', ts: 3, type: 'info', code: 'c', readBy: [], hiddenFor: ['someone'] },
        { id: 'flag', ts: 2, type: 'info', code: 'd', read: true },
      ],
    }))
    const rows = await listNotifications(file)
    expect(rows.map(n => [n.id, n.read])).toEqual([['read-by-me', true], ['unread', false], ['flag', true]])
  })
})
