/**
 * cli-doctor.ts — `agentop doctor [--exposed]`.
 *
 * Prints the go-live checklist and exits non-zero on any failure, so exposing an instance can
 * be gated on a single command instead of on remembering nine environment variables.
 * `--exposed` evaluates against the strict (public) bar even when the profile is not yet set,
 * which is how you check readiness BEFORE flipping it.
 *
 * It evaluates the configuration the central will actually RUN with: on a Docker deployment
 * that is `central.env`, not the shell you typed the command in (see deployment-config.ts).
 * The source is always printed, so the verdict is never about an ambiguous machine.
 */
import { existsSync, readFileSync } from 'node:fs'
import * as path from 'node:path'
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

/** `central.env` beside the compose files, or next to the binary's working directory. */
function findEnvFile(): string | null {
  const candidates = [
    process.env.ENV_FILE,
    path.join(process.cwd(), 'central.env'),
    path.join(process.env.HOME ?? '', '.agentistics', 'central', 'central.env'),
  ].filter((p): p is string => !!p)
  for (const c of candidates) if (existsSync(c)) return c
  return null
}

export async function runDoctor(argv: string[]): Promise<never> {
  const exposed = argv.includes('--exposed')

  const envPath = findEnvFile()
  const cfg = resolveDeploymentConfig(
    envPath ? readFileSync(envPath, 'utf8') : null,
    process.env as Record<string, string | undefined>,
  )

  // Derive the profile and capabilities from the DEPLOYMENT's config, not from this process's
  // singletons — the container is what will serve traffic.
  const env = {
    central: cfg.central,
    exposure: cfg.exposure,
    allowLocalShell: cfg.allowLocalShell,
    tls: cfg.tls,
  }
  const profile = resolveProfile(env)
  const caps = capabilitiesFor(profile, env)

  // Owner MFA + token counts need the database; a central that cannot reach it cannot be
  // declared ready either, so a lookup failure is surfaced rather than silently passed.
  let ownersWithoutMfa: string[] = []
  let machineTokenCount = 0
  let dbError: string | null = null
  if (cfg.central) {
    try {
      const [{ listAccounts }, { accountsWithoutMfa }, { listMachines }] = await Promise.all([
        import('./accounts'),
        import('./mfa-store'),
        import('./team-tokens'),
      ])
      const accounts = await listAccounts()
      const owners = accounts.filter(a => a.role === 'owner')
      const missing = new Set(await accountsWithoutMfa(owners.map(o => o._id)))
      ownersWithoutMfa = owners.filter(o => missing.has(o._id)).map(o => o.email)
      machineTokenCount = (await listMachines()).length
    } catch (err) {
      dbError = err instanceof Error ? err.message : String(err)
    }
  }

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
    ownersWithoutMfa,
    mongoAuthenticated: cfg.mongoAuthenticated,
    machineTokenCount,
    dbUnavailable: !!dbError,
    nativeBind: { ports: [PORT, WEB_PORT], result: nativeBindResult },
  })

  const readFrom = cfg.source === 'file' ? envPath : 'this process environment'
  console.log(`\n  agentistics — exposure preflight ${DIM}(profile: ${exposed ? 'public (forced)' : profile})${RESET}`)
  console.log(`  ${DIM}config read from: ${readFrom}${RESET}\n`)

  for (const c of checks) {
    const icon = c.status === 'pass' ? `${GREEN}✓${RESET}` : c.status === 'warn' ? `${YELLOW}!${RESET}` : `${RED}✗${RESET}`
    console.log(`  ${icon} ${c.label}`)
    console.log(`    ${DIM}${c.detail}${RESET}`)
  }

  if (dbError) {
    console.log(`\n  ${YELLOW}!${RESET} Database unreachable — owner-MFA and machine-token checks could not run.`)
    console.log(`    ${DIM}${dbError}${RESET}`)
    if (cfg.source === 'file') {
      console.log(`    ${DIM}Expected when the database is only reachable from inside the compose network;${RESET}`)
      console.log(`    ${DIM}re-run inside the container: ./central.sh doctor${RESET}`)
    }
  }

  const ok = allPassed(checks) && !dbError
  console.log(
    ok
      ? `\n  ${GREEN}Ready to expose.${RESET}\n`
      : `\n  ${RED}NOT ready${RESET} — fix every ✗ above before opening the tunnel.\n`,
  )
  process.exit(ok ? 0 : 1)
}
