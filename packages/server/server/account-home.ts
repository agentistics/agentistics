/**
 * account-home.ts — the ACCOUNT's home directory, which an overridden `HOME` does not move.
 *
 * `os.userInfo().homedir` is documented as the account database's answer, but under Bun it returns
 * `$HOME` (measured 2026-10-04: `HOME=/tmp/x bun -e "os.userInfo().homedir"` → `/tmp/x`). Every rule
 * that tells "the owner's own store" from an isolated one (a preview, a second instance) must not be
 * fooled by the very override that makes the instance isolated, so the uid's passwd entry is read.
 */
import { readFileSync } from 'node:fs'
import { userInfo } from 'node:os'

/** PURE. The home field of `uid`'s line in a passwd file's text, or null. */
export function homeFromPasswd(passwd: string, uid: number): string | null {
  for (const line of passwd.split('\n')) {
    const f = line.split(':')
    if (f.length >= 7 && Number(f[2]) === uid && f[5]) return f[5]
  }
  return null
}

export function accountHome(): string {
  try {
    const uid = process.getuid?.()
    if (uid !== undefined) {
      const home = homeFromPasswd(readFileSync('/etc/passwd', 'utf-8'), uid)
      if (home) return home
    }
  } catch { /* no passwd file (macOS directory services, Windows) */ }
  try { return userInfo().homedir } catch { return process.env.HOME ?? '' }
}
