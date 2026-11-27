/**
 * `agentop cloud login | status | logout` — pairing this machine with Agentistics Cloud.
 *
 *   agentop cloud login [--name <machine name>]
 *   agentop cloud status
 *   agentop cloud logout [--local]        (--local: forget the credential without telling the Cloud)
 *
 * This process is a vault CLIENT: it holds no key and no token. It resolves the Cloud URL, asks the
 * running service (`vault.sock`, cloud/ops.ts) and prints the answer. Exit 0 only when the command
 * did what it was asked (`status`: connected).
 */
import { hostname } from 'node:os'
import { pollUntilFinal } from './cloud/client'
import { resolveCloudUrl } from './cloud/url'
import type { CloudReply } from './cloud/ops'

const USAGE = [
  'usage: agentop cloud login [--name <machine name>]',
  '       agentop cloud status',
  '       agentop cloud logout [--local]',
].join('\n')

export type CloudCommand =
  | { kind: 'login'; name?: string }
  | { kind: 'status' }
  | { kind: 'logout'; local: boolean }
  | { kind: 'error'; message: string }

export function parseCloudArgs(args: readonly string[]): CloudCommand {
  const [verb, ...rest] = args
  if (verb === 'status' && rest.length === 0) return { kind: 'status' }
  if (verb === 'logout' && (rest.length === 0 || (rest.length === 1 && rest[0] === '--local'))) return { kind: 'logout', local: rest.length === 1 }
  if (verb === 'login') {
    if (rest.length === 0) return { kind: 'login' }
    if (rest.length === 2 && rest[0] === '--name' && rest[1]!.trim()) return { kind: 'login', name: rest[1]! }
  }
  return { kind: 'error', message: USAGE }
}

/** Text from the Cloud is printed to a terminal: no control characters. */
const clean = (v: unknown): string => String(v ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, 500)

const machineName = (name: string): string => clean(name).trim().slice(0, 80) || 'agentop'

/** Handed in by cli.ts (vault/client.ts `cloudCliIo`), so this module reaches no file or socket. */
export interface CloudCliDeps {
  prefs: () => Promise<{ cloud?: { url?: string } }>
  /** Asks the service; null when nothing answers. */
  ask: (req: { op: string } & Record<string, unknown>) => Promise<unknown>
  /** What to say when nothing answers. */
  serviceDown: string
  env?: Record<string, string | undefined>
  out?: (line: string) => void
  err?: (line: string) => void
  sleep?: (ms: number) => Promise<unknown>
}

class Refused extends Error {}

export async function runCloud(args: readonly string[], deps: CloudCliDeps): Promise<number> {
  const out = deps.out ?? ((l) => console.log(l))
  const err = deps.err ?? ((l) => console.error(l))
  const cmd = parseCloudArgs(args)
  if (cmd.kind === 'error') { err(cmd.message); return 2 }
  const url = resolveCloudUrl(deps.env ?? process.env, await deps.prefs())
  if (!url.ok) { err(url.sentence); return 1 }

  const call = async (req: { op: string } & Record<string, unknown>) => {
    const r = await deps.ask(req) as CloudReply | null
    if (!r) throw new Refused(deps.serviceDown)
    // An older running service does not know these ops and answers a bare `bad-request`.
    if (!r.ok) throw new Refused(r.code === 'bad-request' ? 'The running agentop service did not accept this command. Restart it (`agentop restart server`) and try again.' : clean(r.sentence) || clean(r.code))
    return r as Record<string, unknown>
  }
  const flows = (f: unknown) => Object.entries((f ?? {}) as Record<string, unknown>).map(([k, v]) => `${clean(k)} ${v === true ? 'on' : 'off'}`).join(', ')
  /** The paired Cloud wins over the setting; say so when they differ. */
  const otherUrl = (paired: unknown) => {
    if (paired && paired !== url.url) out(`Note: this machine is paired with ${clean(paired)}, not the configured ${url.url}.`)
  }

  try {
    if (cmd.kind === 'login') {
      const start = await call({ op: 'cloud-login-start', url: url.url, name: machineName(cmd.name ?? hostname()) })
      out(`To connect this machine, open ${clean(start.verificationUriComplete)}`)
      out(`and confirm the code ${clean(start.userCode)} (or type it at ${clean(start.verificationUri)}).`)
      out('Waiting for approval… (Ctrl+C to give up)')
      const result = await pollUntilFinal(
        { interval: Number(start.interval), expiresIn: Number(start.expiresIn) },
        async () => await call({ op: 'cloud-login-poll', handle: start.handle }) as Record<string, unknown> & { status: string },
        deps.sleep,
      )
      if (result.status !== 'paired') {
        err(result.status === 'denied' ? 'The pairing was refused.' : 'The code expired before it was approved. Run `agentop cloud login` again.')
        return 1
      }
      const paired = result as Record<string, unknown>
      out(`Connected. Machine ${clean(paired.machineId)}, workspace ${clean(paired.workspaceId)}.`)
      out(`Allowed: ${flows(paired.flows)}`)
      return 0
    }

    if (cmd.kind === 'status') {
      const r = await call({ op: 'cloud-status' })
      if (!r.connected) {
        err(r.pairAgain ? clean(r.pairAgain) : 'Not connected. Run `agentop cloud login`.')
        return 1
      }
      const m = r.machine as Record<string, unknown>
      out(`Connected to ${clean(r.cloudUrl)}`)
      out(`  machine    ${clean(m.name)} (${clean(m.kind)}) ${clean(m.id)}`)
      out(`  workspace  ${clean(m.workspaceId)}`)
      out(`  paired     ${clean(m.pairedAt)}`)
      out(`  allowed    ${flows(m.flows)}`)
      out(`  signing    ${clean(r.signingFingerprint)}`)
      out(`  envelope   ${clean(r.envelopeFingerprint)}`)
      otherUrl(r.cloudUrl)
      return 0
    }

    const r = await call({ op: 'cloud-logout', local: cmd.local })
    if (!r.connected) { out('Not connected: there is nothing to log out of.'); return 0 }
    out(r.outcome === 'removed-locally'
      ? `The credential was removed from this machine. ${clean(r.cloudUrl)} was not told: remove the machine there too.`
      : r.outcome === 'already-revoked'
        ? `${clean(r.cloudUrl)} had already revoked this machine. The local credential was removed.`
        : `Disconnected from ${clean(r.cloudUrl)}. Local data stays on this machine.`)
    otherUrl(r.cloudUrl)
    return 0
  } catch (e) {
    if (!(e instanceof Refused)) throw e
    err(e.message)
    if (cmd.kind === 'logout' && !cmd.local) err('Nothing was removed. `agentop cloud logout --local` forgets the credential without telling the Cloud.')
    return 1
  }
}
