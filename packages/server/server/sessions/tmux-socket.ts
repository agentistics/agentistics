/**
 * tmux-socket.ts — WHICH tmux socket this process's fleet and shells live on.
 *
 * The owner's own store (`~/.agentistics` of the ACCOUNT's home, `os.userInfo().homedir`, which an
 * overridden `HOME` does not move) keeps the historical names `agentop` / `agentop-shell`, so every
 * session already running stays visible after an upgrade. ANY other data dir — a throwaway preview
 * with an isolated HOME, a second instance, a test run — gets its own `agentop-<8 hex>` derived
 * from the data dir. tmux sockets are per user (`/tmp/tmux-<uid>/<name>`), not per HOME, so without
 * this a preview listed the owner's real sessions as `unregistered` and could have acted on them.
 */
import { userInfo } from 'node:os'
import { join, resolve } from 'node:path'
import { AGENTISTICS_DATA_DIR } from '../config'

/** FNV-1a, 32 bits, as 8 hex digits — stable across runs and platforms, no dependency. */
function fnv8(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/** PURE. The socket name for `base` on a data dir: the owner's store keeps `base`, any other gets a suffix. */
export function socketForDataDir(base: string, dataDir: string, ownerDataDir: string): string {
  const dir = resolve(dataDir)
  return dir === resolve(ownerDataDir) ? base : `${base}-${fnv8(dir)}`
}

function ownerDataDir(): string {
  try { return join(userInfo().homedir, '.agentistics') } catch { return join(process.env.HOME ?? '', '.agentistics') }
}

export const TMUX_SOCKET = socketForDataDir('agentop', AGENTISTICS_DATA_DIR, ownerDataDir())
export const SHELL_SOCKET = socketForDataDir('agentop-shell', AGENTISTICS_DATA_DIR, ownerDataDir())
