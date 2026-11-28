/** Tests only: bind the last-message store to a throwaway JSON file (null unbinds: memory only), standing in for the
 *  registry rows `index.ts` binds it to. */
import { readFileSync, writeFileSync } from 'node:fs'
import { bindLastMessagesStore, flushLastMessages, reloadLastMessagesFromDisk, type LastMessage } from './last-message'

export function useLastMessagesFile(path: string | null): void {
  if (!path) { bindLastMessagesStore(null); return }
  const read = (): Record<string, LastMessage> => { try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return {} } }
  bindLastMessagesStore({
    read: () => Object.entries(read()),
    save: async (id, m) => {
      const all = read()
      if (m) all[id] = m; else delete all[id]
      writeFileSync(path, JSON.stringify(all), { mode: 0o600 })
    },
  })
}

/** What a server restart does: every queued save lands, then the in-memory copy is dropped. */
export async function restartLastMessages(): Promise<void> {
  await flushLastMessages()
  reloadLastMessagesFromDisk()
}
