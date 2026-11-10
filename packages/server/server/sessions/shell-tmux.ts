import { hostWhich } from '../host-which'
/** All utility shell channels must resolve the SAME executable, including under launchd's PATH. */
export function resolveShellTmux(
  platform: string,
  which: (name: string) => string | null,
): string | null {
  const onPath = which('tmux')
  if (onPath) return onPath
  if (platform === 'darwin') {
    for (const path of ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux']) {
      const found = which(path)
      if (found) return found
    }
  }
  return null
}

export async function shellTmux(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const executable = resolveShellTmux(process.platform, name => hostWhich(name, { negativeTtlMs: 30_000 }))
  if (!executable) return { code: 127, out: '', err: 'tmux executable not found' }
  try {
    const p = Bun.spawn([executable, ...args], { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' })
    const timer = setTimeout(() => p.kill(), 10_000)
    try {
      const [out, err, code] = await Promise.all([
        new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited,
      ])
      return { code, out, err }
    } finally { clearTimeout(timer) }
  } catch {
    return { code: 127, out: '', err: 'tmux could not be started' }
  }
}
