/** Exclusive conversation claim shared by the server, cockpit and one-shot CLI processes. */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AGENTISTICS_DATA_DIR } from '../config'
import { withResumeLock } from './resume-lock'

/** Injectable root lets independent callers test the same on-disk exclusion without a real HOME. */
export function createConversationResumeLock(root: string, timeoutMs = 60_000) {
  return async function lock<T>(conversationId: string, fn: () => Promise<T>): Promise<T> {
    mkdirSync(root, { recursive: true, mode: 0o700 })
    const dir = join(root, createHash('sha256').update(conversationId).digest('hex'))
    const deadline = Date.now() + timeoutMs
    for (;;) {
      try {
        // Synchronous mkdir + owner write: no asynchronous gap while our claim has no owner.
        mkdirSync(dir, { mode: 0o700 })
        try { writeFileSync(join(dir, 'pid'), String(process.pid), { mode: 0o600 }) }
        catch (e) { rmSync(dir, { recursive: true, force: true }); throw e }
        break
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
        let abandoned = false
        try {
          const pid = Number(readFileSync(join(dir, 'pid'), 'utf8'))
          if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('invalid lock owner')
          try { process.kill(pid, 0) } catch (e) {
            abandoned = (e as NodeJS.ErrnoException).code === 'ESRCH'
          }
        } catch {
          // A process may have died between mkdir and writing pid. Allow that tiny window to
          // close before recovering; NEVER expire a live owner's long-running spawn by age.
          try { abandoned = Date.now() - statSync(dir).birthtimeMs > 60_000 } catch { continue }
        }
        if (abandoned) {
          // Elect one reaper INSIDE the old directory. A second reaper must re-read the owner
          // after acquiring this marker: it may now be looking at a fresh lock at the same path.
          const reaping = join(dir, 'reaping')
          let elected = false
          try { mkdirSync(reaping); elected = true } catch { /* another reaper won */ }
          if (elected) {
            let moved = false
            try {
              let stillAbandoned = false
              try {
                const owner = Number(readFileSync(join(dir, 'pid'), 'utf8'))
                if (Number.isSafeInteger(owner) && owner > 0) {
                  try { process.kill(owner, 0) } catch (e) { stillAbandoned = (e as NodeJS.ErrnoException).code === 'ESRCH' }
                } else { stillAbandoned = Date.now() - statSync(dir).birthtimeMs > 60_000 }
              } catch { stillAbandoned = Date.now() - statSync(dir).birthtimeMs > 60_000 }
              if (stillAbandoned) {
                const aside = `${dir}.abandoned-${process.pid}-${Date.now()}`
                renameSync(dir, aside)
                moved = true
                rmSync(aside, { recursive: true, force: true })
                continue
              }
            } finally { if (!moved) rmSync(reaping, { recursive: true, force: true }) }
          }
        }
        if (Date.now() >= deadline) throw new Error('Conversation reopen is already in progress; retry shortly.')
        await new Promise(r => setTimeout(r, 25))
      }
    }
    try { return await fn() }
    finally { rmSync(dir, { recursive: true, force: true }) }
  }
}

const diskLock = createConversationResumeLock(join(AGENTISTICS_DATA_DIR, 'conversation-resumes'))
export function withConversationResumeLock<T>(conversationId: string, fn: () => Promise<T>): Promise<T> {
  return withResumeLock(conversationId, () => diskLock(conversationId, fn))
}
