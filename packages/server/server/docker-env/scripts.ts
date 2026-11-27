/**
 * DOCKER.AMBIENTES S2 — the POSIX `sh` / plain-JS helpers agentop mounts read-only at `/opt/agentistics`
 * (SPEC-r3 §3.3 step 6, §3.6). They are agentop's own files, written by the launcher, never the image's: the
 * image's ENTRYPOINT never runs (`--entrypoint /opt/agentistics/exec-wrap` always).
 *
 * `exec-wrap <ttl> <cmd…>`: exports install grants (only ever mounted in the download container), then EXECs
 * `timeout` — so the TTL holds INSIDE the container even when the launcher is dead, and `timeout` forwards the
 * `docker kill --signal TERM` to the command. Exit 124 = TTL, 137 = killed (OOM or the watchdog); the launcher
 * says which in words.
 *
 * `fwd.mjs` (runs under the image's own runtime — bun or node; the images carry no socat): `out` listens on
 * 127.0.0.1:<port> inside and pipes each connection to the egress unix socket; `in` listens on a unix socket and
 * pipes each connection to 127.0.0.1:<port> inside (serve ingress).
 */

export const EXEC_WRAP_SH = `#!/bin/sh
# agentistics exec-wrap (written by agentop; read-only inside the container)
ttl="$1"; shift
if [ -d /run/secrets ]; then
  for f in /run/secrets/*; do
    [ -f "$f" ] || continue
    n=$(basename "$f")
    case "$n" in *[!A-Za-z0-9_]*) continue ;; esac
    export "$n=$(cat "$f")"
  done
fi
exec timeout -s TERM -k 10 "$ttl" "$@"
`

export const FWD_MJS = `// agentistics forwarder (written by agentop)
import net from 'node:net'
const [mode, port, sock] = process.argv.slice(2)
const pipe = (a, b) => { a.pipe(b); b.pipe(a); a.on('error', () => b.destroy()); b.on('error', () => a.destroy()); a.on('close', () => b.destroy()); b.on('close', () => a.destroy()) }
if (mode === 'out') {
  net.createServer(c => pipe(c, net.createConnection({ path: sock }))).listen(Number(port), '127.0.0.1')
} else if (mode === 'in') {
  net.createServer(c => pipe(c, net.createConnection({ host: '127.0.0.1', port: Number(port) }))).listen(sock)
}
`

/** The words for a container's exit code, or null when it is the command's own. */
export function exitWords(code: number, ctx: { ttlSec: number; memoryBytes: number; watchdog?: string | null }): string | null {
  if (ctx.watchdog) return ctx.watchdog
  if (code === 124) return `agentop run: the time limit (${ctx.ttlSec}s) ended the command`
  if (code === 137) return `agentop run: the environment ran out of memory (limit ${(ctx.memoryBytes / 1024 ** 3).toFixed(1)} GB) or was killed`
  return null
}
