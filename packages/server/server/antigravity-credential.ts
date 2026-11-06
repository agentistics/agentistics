import { access, readFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { ANTIGRAVITY_DIR } from './config'

export interface AntigravityCredentialIo {
  platform: NodeJS.Platform
  defaultRoot: string
  readFile: (path: string) => Promise<string>
  resolveExecutable: (candidates: string[]) => Promise<string | null>
  run: (command: string, args: string[], options: { timeoutMs: number; maxBytes: number }) => Promise<{ code: number; stdout: string }>
}

/** No shell, no stderr, bounded private stdout. Kill and reap before returning on failure. */
const run: AntigravityCredentialIo['run'] = (command, args, { timeoutMs, maxBytes }) => new Promise(resolve => {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'] })
  const chunks: Buffer[] = []
  let bytes = 0, failed = false
  const abort = (): void => {
    failed = true
    chunks.length = 0
    child.kill('SIGKILL')
    child.stdout.destroy()
  }
  const timer = setTimeout(abort, timeoutMs)
  child.stdout.on('data', (chunk: Buffer) => {
    bytes += chunk.length
    if (bytes > maxBytes) { abort(); return }
    if (!failed) chunks.push(chunk)
  })
  child.on('error', () => { failed = true })
  child.on('close', code => {
    clearTimeout(timer)
    resolve({ code: failed ? -1 : (code ?? -1), stdout: failed ? '' : Buffer.concat(chunks).toString('utf8') })
  })
})

const defaults: AntigravityCredentialIo = {
  platform: process.platform,
  defaultRoot: ANTIGRAVITY_DIR,
  readFile: path => readFile(path, 'utf8'),
  resolveExecutable: async candidates => {
    for (const candidate of candidates) {
      if (!candidate.includes('/')) return Bun.which(candidate)
      try { await access(candidate, constants.X_OK); return candidate } catch { /* try next location */ }
    }
    return null
  },
  run,
}

/** `search --all` prints metadata even for locked entries; only one readable secret is safe. */
function credentialFromSearch(stdout: string): string | null {
  const blocks = stdout.split(/^\[\/[^\]\r\n]+\]\r?$/m)
  if (blocks.length < 2 || blocks.shift()!.trim()) return null
  let text: string | null = null
  for (const block of blocks) {
    for (const match of block.matchAll(/^secret = /gm)) {
      if (text !== null) return null
      text = block.slice(match.index + match[0].length)
    }
  }
  if (text === null) return null
  let start = 0
  while (start < text.length && /\s/.test(text[start]!)) start++
  if (text[start] !== '{') return null
  let depth = 0, quoted = false, escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!
    if (quoted) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') quoted = false
      continue
    }
    if (ch === '"') quoted = true
    else if (ch === '{' || ch === '[') depth++
    else if (ch === '}' || ch === ']') {
      if (--depth === 0) {
        const raw = text.slice(start, i + 1)
        try { JSON.parse(raw); return raw } catch { return null }
      }
    }
  }
  return null
}

/** File precedence is strict: only ENOENT permits the default Linux login's keyring fallback. */
export async function readAntigravityCredential(root: string, io: Partial<AntigravityCredentialIo> = {}): Promise<string | null> {
  const ops = { ...defaults, ...io }
  try { return await ops.readFile(join(root, 'antigravity-oauth-token')) } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') return null
  }
  if (ops.platform !== 'linux' || root !== ops.defaultRoot) return null
  try {
    const executable = await ops.resolveExecutable(['/usr/bin/secret-tool', '/bin/secret-tool', 'secret-tool'])
    if (!executable) return null
    const { code, stdout } = await ops.run(executable, ['search', '--all', 'service', 'gemini', 'username', 'antigravity'], { timeoutMs: 2000, maxBytes: 1024 * 1024 })
    if (code !== 0 || Buffer.byteLength(stdout) > 1024 * 1024) return null
    return credentialFromSearch(stdout)
  } catch { return null }
}
