/**
 * cli-doctor.ts — `agentop doctor [--exposed]`.
 *
 * Prints the go-live checklist and exits non-zero on any failure, so exposing an instance can
 * be gated on a single command instead of on remembering nine environment variables.
 * `--exposed` evaluates against the strict (public) bar even when the profile is not yet set,
 * which is how you check readiness BEFORE flipping it.
 *
 * It evaluates this process's environment (see deployment-config.ts). The source is always
 * printed, so the verdict is never about an ambiguous machine.
 */
import { existsSync, readFileSync } from 'node:fs'
import { capabilitiesFor, resolveProfile } from './exposure'
import { runPreflight, allPassed } from './preflight'
import { resolveDeploymentConfig } from './deployment-config'
import { readNativeBind } from './native-bind'
import { PORT, WEB_PORT } from './config'

const GREEN = '\x1b[92m'
const RED = '\x1b[91m'
const YELLOW = '\x1b[93m'
const DIM = '\x1b[2m'
const RESET = '\x1b[0m'

export async function runDoctor(argv: string[]): Promise<never> {
  const exposed = argv.includes('--exposed')

  // WSL: a missing/stale logon entry means the distro (and agentop) is down until a terminal opens.
  try {
    const { repairWslAutostart } = await import('./autostart')
    const line = await repairWslAutostart({ enableIfMissing: false })
    if (line) process.stdout.write(`  ${line}\n`)
  } catch { /* best-effort: the doctor's own checks must still run */ }

  const cfg = resolveDeploymentConfig(null, process.env as Record<string, string | undefined>)

  // Derive the profile and capabilities from the DEPLOYMENT's config, not from this process's
  // singletons — the container is what will serve traffic.
  const env = {
    central: false,
    exposure: cfg.exposure,
    allowLocalShell: cfg.allowLocalShell,
    tls: cfg.tls,
  }
  const profile = resolveProfile(env)
  const caps = capabilitiesFor(profile, env)

  // What THIS process's own server actually listens on, independent of BIND_IP/cfg.bindIp — the
  // `bind-ip` check above only ever reads a Docker-only env var, and `index.ts` binds `0.0.0.0`
  // unconditionally today regardless of it (security finding S-1; see native-bind.ts's header).
  const nativeBindResult = readNativeBind([PORT, WEB_PORT])

  const checks = runPreflight({
    profile: exposed ? 'public' : profile,
    caps,
    sessionSecret: cfg.sessionSecret,
    password: cfg.password,
    tls: cfg.tls,
    trustProxy: cfg.trustProxy,
    bindIp: cfg.bindIp,
    allowedOrigins: cfg.allowedOrigins,
    ownersWithoutMfa: [],
    mongoAuthenticated: cfg.mongoAuthenticated,
    machineTokenCount: 0,
    dbUnavailable: false,
    nativeBind: { ports: [PORT, WEB_PORT], result: nativeBindResult },
  })

  const readFrom = 'this process environment'
  console.log(`\n  agentistics — exposure preflight ${DIM}(profile: ${exposed ? 'public (forced)' : profile})${RESET}`)
  console.log(`  ${DIM}config read from: ${readFrom}${RESET}\n`)

  for (const c of checks) {
    const icon = c.status === 'pass' ? `${GREEN}✓${RESET}` : c.status === 'warn' ? `${YELLOW}!${RESET}` : `${RED}✗${RESET}`
    console.log(`  ${icon} ${c.label}`)
    console.log(`    ${DIM}${c.detail}${RESET}`)
  }

  // The environment sessions start in (login-env.ts): counts and names only, never values.
  {
    const { resolveLoginEnv } = await import('./sessions/login-env')
    const r = await resolveLoginEnv()
    const icon = r.source === 'login' ? `${GREEN}✓${RESET}` : `${YELLOW}!${RESET}`
    const segs = (r.env?.PATH ?? '').split(':').filter(Boolean).length
    const vars = Object.keys(r.env ?? {}).filter(k => k !== 'PATH').join(', ') || 'none'
    console.log(`\n  ${icon} Session environment (${r.source})`)
    console.log(`    ${DIM}login-shell PATH: ${segs} entries; toolchain vars: ${vars}${RESET}`)
  }

  // The service (Linux, solo/member machines): is the server that holds the data dir the one the
  // unit started? Informational — it does not decide the exposure verdict below.
  if (process.platform === 'linux') {
    const { serviceFindings, parseIsActive } = await import('./server-restart-plan')
    const { unitPath } = await import('./autostart')
    const { probeInstanceLock } = await import('./single-instance')
    const { serverLockFile } = await import('./config')
    const unitFile = unitPath('server')
    const unitText = existsSync(unitFile) ? readFileSync(unitFile, 'utf8') : null
    if (unitText !== null) {
      const pid = await probeInstanceLock(serverLockFile())
      let cgroup = ''
      if (pid !== null) { try { cgroup = readFileSync(`/proc/${pid}/cgroup`, 'utf8') } catch { /* gone */ } }
      let unitActive: boolean | null = null
      try {
        const p = Bun.spawnSync(['systemctl', '--user', 'is-active', 'agentop-server'], { stderr: 'ignore' })
        unitActive = parseIsActive(p.stdout.toString())
      } catch { /* no systemctl */ }
      for (const f of serviceFindings({ unitText, unitActive, holder: pid === null ? null : { pid, cgroup } })) {
        const icon = f.status === 'pass' ? `${GREEN}✓${RESET}` : `${YELLOW}!${RESET}`
        console.log(`\n  ${icon} ${f.label}`)
        console.log(`    ${DIM}${f.detail}${RESET}`)
      }
    }
  }

  const ok = allPassed(checks)
  console.log(
    ok
      ? `\n  ${GREEN}Ready to expose.${RESET}\n`
      : `\n  ${RED}NOT ready${RESET} — fix every ✗ above before opening the tunnel.\n`,
  )
  process.exit(ok ? 0 : 1)
}
