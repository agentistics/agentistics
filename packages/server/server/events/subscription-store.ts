/**
 * subscription-store.ts — the subscriptions on disk. `subscriptions.ts` decides; this file reads
 * and writes one small JSON file.
 *
 * Written atomically (temp file + rename) for the same reason `cli-hooks.ts` writes settings that
 * way: a crash mid-write must leave the old file or the new one, never a truncated one that the
 * producer then reads as "no subscriptions" and goes quiet.
 *
 * A file that cannot be read is an EMPTY store, never an exception. The producer runs inside the
 * daemon; a subscription file somebody hand-edited into invalid JSON must cost the filters, not the
 * daemon.
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { AGENTISTICS_DATA_DIR } from '../config'
import { durableWriteFile } from '../durable-write'
import { EMPTY_STORE, parseStore, type Subscription, type SubscriptionStore } from './subscriptions'

export const SUBSCRIPTIONS_FILE =
  process.env.AGENTISTICS_EVENT_SUBSCRIPTIONS_FILE ?? join(AGENTISTICS_DATA_DIR, 'event-subscriptions.json')

export async function readSubscriptionStore(file = SUBSCRIPTIONS_FILE): Promise<SubscriptionStore> {
  try {
    if (!existsSync(file)) return EMPTY_STORE
    return parseStore(JSON.parse(await readFile(file, 'utf8')) as unknown)
  } catch {
    return EMPTY_STORE
  }
}

export async function readSubscriptions(file = SUBSCRIPTIONS_FILE): Promise<Subscription[]> {
  return (await readSubscriptionStore(file)).subscriptions
}

export async function writeSubscriptionStore(
  store: SubscriptionStore,
  file = SUBSCRIPTIONS_FILE,
): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  await durableWriteFile(file, `${JSON.stringify(store, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
}
