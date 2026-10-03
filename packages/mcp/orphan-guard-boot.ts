/**
 * Side-effect module: the FIRST import of `agentistics-mcp.ts`, so the guard is armed before any heavy
 * module (journal, projections, …) evaluates — a client that dies during a slow start must not leave an orphan.
 * `AGENTISTICS_MCP_NO_ORPHAN_GUARD=1` is for debugging a server by hand with its stdin closed.
 */
import { installOrphanGuard } from './orphan-guard'

if (process.env.AGENTISTICS_MCP_NO_ORPHAN_GUARD !== '1') {
  installOrphanGuard({
    stdin: process.stdin, stdout: process.stdout, proc: process,
    getPpid: () => process.ppid, exit: c => process.exit(c),
    setInterval: (f, ms) => setInterval(f, ms), clearInterval: h => clearInterval(h as ReturnType<typeof setInterval>),
  })
}
