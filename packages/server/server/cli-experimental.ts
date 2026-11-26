/**
 * `agentop experimental enable | disable | status`.
 *
 * The experimental features (`EXPERIMENTAL_FEATURES`, @agentistics/core) are variables a module
 * reads once at boot. `enable`/`disable` persist `preferences.experimental`, bounce whatever is
 * running so it re-reads it, and confirm the server came back reporting the state that was asked
 * for. With nothing running it persists and says so — it does not pretend to have restarted.
 *
 * `status` reports the EFFECTIVE state of each feature in every place that decides one, and the
 * source of each: the running server (its own answer), THIS shell (what this process inherited,
 * before its boot corrected it), and the agentop tmux server's GLOBAL environment (what every new
 * session and `agentop mcp` inherits). It never prints "off" while a variable makes it on somewhere:
 * on 2026-10-04 it did exactly that, because the tmux server had inherited `AGENTISTICS_PROVIDER=1`
 * plus the applied-marker from an earlier boot and the marker was read as "the preference set this".
 *
 * `enable`/`disable` also bring that tmux global environment in step (`experimental-env.ts`) and
 * NAME the running processes that still carry the old value — sessions and long-running agentop
 * processes. It never kills, restarts or reopens one of them: that is the owner's call. The one
 * restart it performs is the server's own bounce, as before (and only on a real change).
 */
import { EXPERIMENTAL_FEATURES, resolveExperimental, type ExperimentalStatus } from '@agentistics/core'
import { parseTmuxEnv, staleCarriers, tmuxSyncArgs, type ProcInfo, type StaleCarrier } from './experimental-env'
import { readPreferencesOrExit, writePreferences } from './preferences'
import { resolveLang, type CliLang } from './cli-lang'

const T = {
  en: {
    usage: 'Usage: agentop experimental <enable|disable|status>',
    header: (on: boolean) => `Experimental features — preference: ${on ? 'ON' : 'OFF'}`,
    on: 'on', off: 'off',
    byPreference: 'turned on by the preference',
    byEnv: (v: string, val: string) => `${v}=${val} set explicitly`,
    overridden: (v: string, val: string) => `kept off by ${v}=${val}, which wins over the preference`,
    byDefault: 'off by default',
    inherited: (v: string, val: string) => `${v}=${val} inherited from a process that applied the preference earlier — still in effect there (\`agentop experimental disable\` clears it)`,
    where: { server: 'server', shell: 'this shell', tmux: 'agentop tmux (new sessions)' },
    noServer: 'No server is running here; the lines below are this shell and the agentop tmux environment.',
    shellNote: 'Read from this shell\'s environment; a variable exported only here is not the server\'s.',
    tmuxSynced: (n: number) => `Updated the agentop tmux global environment (${n} change${n === 1 ? '' : 's'}): new sessions and \`agentop mcp\` processes start with the new state.`,
    tmuxFailed: 'Could not update the agentop tmux global environment; new sessions may still start with the old value.',
    carriers: (n: number) => `${n} running process${n === 1 ? '' : 'es'} still carr${n === 1 ? 'ies' : 'y'} the old value — reopen ${n === 1 ? 'it' : 'them'} to take the new one (nothing was closed for you):`,
    carrierSession: (label: string, ids: string) => `  session ${label} — its environment still has ${ids} in the old state (its own agentop commands correct themselves; reopen to clear the shell)`,
    carrierAgentop: (label: string, pid: number) => `  ${label} (pid ${pid}) — decided its state when it started`,
    scanUnavailable: 'Could not list the running processes here (no /proc); sessions and `agentop mcp` started before this change may still carry the old value.',
    saved: (on: boolean) => `Saved: experimental ${on ? 'enabled' : 'disabled'}.`,
    nothingRunning: 'Nothing is running, so nothing was restarted — it applies the next time the server starts.',
    restarting: 'Restarting the running service…',
    back: 'The server is back and reports the new state.',
    notBack: 'The service was restarted but the server did not answer with the new state in time. Check `agentop status`.',
    failed: (m: string) => `The restart failed: ${m}`,
    already: (on: boolean) => `Experimental is already ${on ? 'enabled' : 'disabled'}: nothing changed, so nothing was restarted.`,
    alreadyButServer: (on: boolean) => `The preference is already ${on ? 'enabled' : 'disabled'}, but the running server reports ${on ? 'off' : 'on'} (an environment override, or a server started before the change). Nothing was restarted; run \`agentop restart server\` to apply it.`,
  },
  pt: {
    usage: 'Uso: agentop experimental <enable|disable|status>',
    header: (on: boolean) => `Recursos experimentais — preferência: ${on ? 'LIGADOS' : 'DESLIGADOS'}`,
    on: 'ligado', off: 'desligado',
    byPreference: 'ligado pela preferência',
    byEnv: (v: string, val: string) => `${v}=${val} definida explicitamente`,
    overridden: (v: string, val: string) => `mantido desligado por ${v}=${val}, que vence a preferência`,
    byDefault: 'desligado por padrão',
    inherited: (v: string, val: string) => `${v}=${val} herdada de um processo que aplicou a preferência antes — ainda vale ali (\`agentop experimental disable\` limpa)`,
    where: { server: 'servidor', shell: 'este shell', tmux: 'tmux do agentop (novas sessões)' },
    noServer: 'Nenhum servidor rodando aqui; as linhas abaixo são deste shell e do ambiente do tmux do agentop.',
    shellNote: 'Lido do ambiente deste shell; uma variável exportada só aqui não é a do servidor.',
    tmuxSynced: (n: number) => `Ambiente global do tmux do agentop atualizado (${n} mudança${n === 1 ? '' : 's'}): novas sessões e processos \`agentop mcp\` já sobem com o novo estado.`,
    tmuxFailed: 'Não foi possível atualizar o ambiente global do tmux do agentop; novas sessões podem subir ainda com o valor antigo.',
    carriers: (n: number) => `${n} processo${n === 1 ? '' : 's'} em execução ainda ${n === 1 ? 'carrega' : 'carregam'} o valor antigo — reabra ${n === 1 ? 'o' : 'os'} para pegar o novo (nada foi fechado por você):`,
    carrierSession: (label: string, ids: string) => `  sessão ${label} — o ambiente dela ainda tem ${ids} no estado antigo (os comandos agentop dela se corrigem sozinhos; reabra para limpar o shell)`,
    carrierAgentop: (label: string, pid: number) => `  ${label} (pid ${pid}) — decidiu o estado quando subiu`,
    scanUnavailable: 'Não deu para listar os processos em execução aqui (sem /proc); sessões e `agentop mcp` abertos antes desta mudança podem ainda carregar o valor antigo.',
    saved: (on: boolean) => `Salvo: experimental ${on ? 'ligado' : 'desligado'}.`,
    nothingRunning: 'Nada está rodando, então nada foi reiniciado — vale na próxima vez que o servidor subir.',
    restarting: 'Reiniciando o serviço em execução…',
    back: 'O servidor voltou e informa o novo estado.',
    notBack: 'O serviço foi reiniciado, mas o servidor não respondeu com o novo estado a tempo. Veja `agentop status`.',
    failed: (m: string) => `O reinício falhou: ${m}`,
    already: (on: boolean) => `O modo experimental já está ${on ? 'ligado' : 'desligado'}: nada mudou, então nada foi reiniciado.`,
    alreadyButServer: (on: boolean) => `A preferência já está ${on ? 'ligada' : 'desligada'}, mas o servidor em execução informa ${on ? 'desligado' : 'ligado'} (uma variável de ambiente, ou um servidor iniciado antes da mudança). Nada foi reiniciado; rode \`agentop restart server\` para aplicar.`,
  },
} as const

function why(r: ExperimentalStatus, lang: CliLang): string {
  const t = T[lang]
  if (r.source === 'env') return r.overridden ? t.overridden(r.env, r.envValue ?? '') : t.byEnv(r.env, r.envValue ?? '')
  if (r.source === 'inherited') return t.inherited(r.env, r.envValue ?? '')
  return r.source === 'preference' ? t.byPreference : t.byDefault
}

/** One place that decides a feature's state, and what it decided. */
export interface StatusPlace { where: 'server' | 'shell' | 'tmux'; rows: ExperimentalStatus[] }

/**
 * The status, per feature, with its EFFECTIVE state in every place given and the source of each.
 * The feature's own line is ON when ANY place has it on — "off" while a variable makes it on
 * somewhere is the defect this replaces. With one place (the old shape) it reads as before.
 */
export function statusLines(pref: boolean | undefined, rows: ExperimentalStatus[] | StatusPlace[], lang: CliLang): string[] {
  const t = T[lang]
  const places: StatusPlace[] = rows.length > 0 && 'where' in (rows[0] as object)
    ? rows as StatusPlace[]
    : [{ where: 'server', rows: rows as ExperimentalStatus[] }]
  const out = [t.header(pref === true)]
  for (const f of EXPERIMENTAL_FEATURES) {
    const here = places.map(p => ({ where: p.where, r: p.rows.find(x => x.id === f.id) })).filter((x): x is { where: StatusPlace['where']; r: ExperimentalStatus } => x.r !== undefined)
    if (here.length === 0) continue
    const on = here.some(x => x.r.on)
    out.push(`  ${on ? '●' : '○'} ${f.id.padEnd(12)} ${(on ? t.on : t.off).padEnd(10)} ${f.env}`)
    out.push(`      ${f.description[lang]}`)
    if (places.length === 1) { out.push(`      ${why(here[0]!.r, lang)}`); continue }
    for (const x of here) out.push(`      ${t.where[x.where]}: ${x.r.on ? t.on : t.off} — ${why(x.r, lang)}`)
  }
  return out
}

/** The running server's own answer, when there is one (`GET /api/experimental`). */
async function askServer(port: string | number = process.env.PORT ?? '47291'): Promise<{ enabled: boolean; features: ExperimentalStatus[] } | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/experimental`, { signal: AbortSignal.timeout(2000) })
    if (!res.ok) return null
    return await res.json() as { enabled: boolean; features: ExperimentalStatus[] }
  } catch { return null }
}

/** The port THIS data dir's server listens on (its recorded ports, while it holds the lock), else `PORT`. */
async function ownServerPort(): Promise<number> {
  const { AGENTISTICS_DATA_DIR, PORT, WEB_PORT, serverLockFile } = await import('./config')
  const { probeInstanceLock } = await import('./single-instance')
  const { bounceTarget, readServerPorts } = await import('./server-ports')
  const t = bounceTarget({
    lockHolder: await probeInstanceLock(serverLockFile()).catch(() => null),
    recorded: await readServerPorts(AGENTISTICS_DATA_DIR), cliPort: PORT, cliWebPort: WEB_PORT,
  })
  return t.kind === 'server' ? t.port : PORT
}

async function waitForState(enabled: boolean, port: number, timeoutMs = 25000): Promise<boolean> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    const r = await askServer(port)
    if (r && r.enabled === enabled) return true
    await new Promise(res => setTimeout(res, 1000))
  }
  return false
}

/** What `runExperimental` touches outside itself — injectable, so a test never reaches a real unit. */
export interface ExperimentalDeps {
  lang?: () => Promise<CliLang>
  readPrefs?: () => Promise<{ experimental?: boolean }>
  writePrefs?: (patch: { experimental: boolean }) => Promise<unknown>
  restart?: () => Promise<{ state: 'nothing-running' | 'restarted' | 'failed'; message: string; port?: number }>
  askServer?: () => Promise<{ enabled: boolean; features: ExperimentalStatus[] } | null>
  waitForState?: (enabled: boolean, port: number) => Promise<boolean>
  log?: (line: string) => void
  error?: (line: string) => void
  /** The agentop tmux server's global environment; `null` when no such server is running. */
  tmuxGlobal?: () => Promise<Record<string, string> | null>
  /** Runs one tmux command against the agentop socket; true on success. */
  tmuxRun?: (args: string[]) => Promise<boolean>
  /** The running processes and the tmux panes (pane pid → session name); `null` where it cannot be read. */
  scan?: () => Promise<{ procs: ProcInfo[]; panes: Map<number, string> } | null>
  /** The experimental variables this process inherited, before its boot corrected them. */
  shellEnv?: () => Record<string, string>
}

async function tmuxSocket(): Promise<string> {
  return (await import('./sessions/tmux-socket')).TMUX_SOCKET
}

async function readTmuxGlobal(): Promise<Record<string, string> | null> {
  try {
    const p = Bun.spawn(['tmux', '-L', await tmuxSocket(), 'show-environment', '-g'], { stdout: 'pipe', stderr: 'ignore', stdin: 'ignore' })
    const text = await new Response(p.stdout).text()
    return (await p.exited) === 0 ? parseTmuxEnv(text) : null
  } catch { return null }
}

async function runTmux(args: string[]): Promise<boolean> {
  try {
    const p = Bun.spawn(['tmux', '-L', await tmuxSocket(), ...args], { stdout: 'ignore', stderr: 'ignore', stdin: 'ignore' })
    return (await p.exited) === 0
  } catch { return false }
}

/** Linux `/proc`: this user's processes (unreadable ones are skipped), plus the agentop tmux panes. */
async function scanProcesses(): Promise<{ procs: ProcInfo[]; panes: Map<number, string> } | null> {
  if (process.platform !== 'linux') return null
  const { readdirSync, readFileSync } = await import('node:fs')
  const { experimentalVars } = await import('./experimental-boot')
  let names: string[]
  try { names = readdirSync('/proc') } catch { return null }
  const procs: ProcInfo[] = []
  for (const n of names) {
    if (!/^\d+$/.test(n)) continue
    try {
      const stat = readFileSync(`/proc/${n}/stat`, 'utf8')
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
      const cmd = readFileSync(`/proc/${n}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ')
      const raw: Record<string, string> = {}
      for (const kv of readFileSync(`/proc/${n}/environ`, 'utf8').split('\0')) {
        const eq = kv.indexOf('=')
        if (eq > 0 && kv.startsWith('AGENTISTICS_')) raw[kv.slice(0, eq)] = kv.slice(eq + 1)
      }
      procs.push({ pid: Number(n), ppid, cmd, env: experimentalVars(raw) })
    } catch { /* gone, or another user's: not ours to report */ }
  }
  const panes = new Map<number, string>()
  try {
    const p = Bun.spawn(['tmux', '-L', await tmuxSocket(), 'list-panes', '-a', '-F', '#{pane_pid} #{session_name}'], { stdout: 'pipe', stderr: 'ignore', stdin: 'ignore' })
    const text = await new Response(p.stdout).text()
    if ((await p.exited) === 0) {
      for (const line of text.split('\n')) {
        const sp = line.indexOf(' ')
        if (sp > 0) panes.set(Number(line.slice(0, sp)), line.slice(sp + 1))
      }
    }
  } catch { /* no tmux: no sessions to name */ }
  return { procs, panes }
}

/** The places OUTSIDE the server: the tmux global environment, then the processes still carrying the old value. */
async function syncOutside(enabled: boolean, deps: ExperimentalDeps, t: (typeof T)[CliLang], log: (l: string) => void): Promise<void> {
  const global = await (deps.tmuxGlobal ?? readTmuxGlobal)()
  if (global) {
    const cmds = tmuxSyncArgs(enabled, global)
    if (cmds.length > 0) {
      let ok = true
      for (const c of cmds) ok = (await (deps.tmuxRun ?? runTmux)(c)) && ok
      log(ok ? t.tmuxSynced(cmds.length) : t.tmuxFailed)
    }
  }
  const scanned = await (deps.scan ?? scanProcesses)()
  if (!scanned) { log(t.scanUnavailable); return }
  const carriers: StaleCarrier[] = staleCarriers(scanned.procs, enabled, { selfPid: process.pid, panes: scanned.panes })
  if (carriers.length === 0) return
  log(t.carriers(carriers.length))
  for (const c of carriers) {
    log(c.kind === 'session'
      ? t.carrierSession(c.label, c.ids.map(id => EXPERIMENTAL_FEATURES.find(f => f.id === id)?.env ?? id).join(', '))
      : t.carrierAgentop(c.label, c.pid))
  }
}

export async function runExperimental(args: string[], deps: ExperimentalDeps = {}): Promise<number> {
  const log = deps.log ?? ((l: string) => console.log(l))
  const error = deps.error ?? ((l: string) => console.error(l))
  // THIS data dir's server (its recorded port), never whatever answers on the default one.
  const ask = deps.askServer ?? (async () => askServer(await ownServerPort()))
  const lang = await (deps.lang ?? resolveLang)()
  const t = T[lang]
  const verb = args.find(a => !a.startsWith('-'))
  if (verb !== 'enable' && verb !== 'disable' && verb !== 'status') {
    console.error(t.usage)
    return 1
  }
  if (verb === 'status') {
    const prefs = await (deps.readPrefs ?? readPreferencesOrExit)()
    const live = await ask()
    const shell = (deps.shellEnv ?? (await import('./experimental-boot')).inheritedExperimentalEnv)()
    const global = await (deps.tmuxGlobal ?? readTmuxGlobal)()
    const places: StatusPlace[] = [
      ...(live ? [{ where: 'server' as const, rows: live.features }] : []),
      { where: 'shell', rows: resolveExperimental(prefs.experimental, shell) },
      ...(global ? [{ where: 'tmux' as const, rows: resolveExperimental(prefs.experimental, global) }] : []),
    ]
    log(statusLines(prefs.experimental, places, lang).join('\n'))
    if (!live) log(`\n${t.noServer}`)
    return 0
  }
  const enabled = verb === 'enable'
  const prefs = await (deps.readPrefs ?? readPreferencesOrExit)()
  // ALREADY in that state: nothing to apply, so nothing is restarted. A repeated `enable` — typed
  // again, or run by accident (a backquoted `agentop experimental enable` inside a double-quoted
  // shell string is EXECUTED by the shell) — must never bounce a production server for no change.
  if ((prefs.experimental === true) === enabled) {
    const live = await ask()
    log(live && live.enabled !== enabled ? t.alreadyButServer(enabled) : t.already(enabled))
    // The preference already says so — but what the tmux server hands to new sessions, and what the
    // running ones carry, may not (the 2026-10-04 case). Never restarts anything.
    await syncOutside(enabled, deps, t, log)
    return 0
  }
  await (deps.writePrefs ?? writePreferences)({ experimental: enabled })
  log(t.saved(enabled))
  const restart = deps.restart ?? (async () => (await import('./cli-start')).restartForConfigChange())
  const r = await restart()
  if (r.state === 'nothing-running') { log(t.nothingRunning); await syncOutside(enabled, deps, t, log); return 0 }
  if (r.state === 'failed') { error(t.failed(r.message)); await syncOutside(enabled, deps, t, log); return 1 }
  log(t.restarting)
  const back = await (deps.waitForState ?? waitForState)(enabled, r.port ?? await ownServerPort())
  if (back) log(t.back)
  else error(t.notBack)
  await syncOutside(enabled, deps, t, log)
  return back ? 0 : 1
}
