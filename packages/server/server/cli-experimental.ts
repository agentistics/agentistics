/**
 * `agentop experimental enable | disable | status`.
 *
 * The experimental features (`EXPERIMENTAL_FEATURES`, @agentistics/core) are variables a module
 * reads once at boot. `enable`/`disable` persist `preferences.experimental`, bounce whatever is
 * running so it re-reads it, and confirm the server came back reporting the state that was asked
 * for. With nothing running it persists and says so — it does not pretend to have restarted.
 *
 * `status` reads THIS shell's environment, which is not necessarily the server's: a variable
 * exported only here would be reported as an override that the running server never saw. It says
 * which it is looking at, and prefers the running server's own answer when there is one.
 */
import { EXPERIMENTAL_FEATURES, resolveExperimental, type ExperimentalStatus } from '@agentistics/core'
import { readPreferencesOrExit, writePreferences } from './preferences'
import { resolveLang, type CliLang } from './cli-lang'

const T = {
  en: {
    usage: 'Usage: agentop experimental <enable|disable|status>',
    header: (on: boolean) => `Experimental features: ${on ? 'ON' : 'OFF'} (preference)`,
    on: 'on', off: 'off',
    byPreference: 'turned on by the preference',
    byEnv: (v: string, val: string) => `${v}=${val} set explicitly`,
    overridden: (v: string, val: string) => `kept off by ${v}=${val}, which wins over the preference`,
    byDefault: 'off by default',
    shellNote: 'Read from this shell\'s environment; a variable exported only here is not the server\'s.',
    saved: (on: boolean) => `Saved: experimental ${on ? 'enabled' : 'disabled'}.`,
    nothingRunning: 'Nothing is running, so nothing was restarted — it applies the next time the server starts.',
    restarting: 'Restarting the running service…',
    back: 'The server is back and reports the new state.',
    notBack: 'The service was restarted but the server did not answer with the new state in time. Check `agentop status`.',
    failed: (m: string) => `The restart failed: ${m}`,
  },
  pt: {
    usage: 'Uso: agentop experimental <enable|disable|status>',
    header: (on: boolean) => `Recursos experimentais: ${on ? 'LIGADOS' : 'DESLIGADOS'} (preferência)`,
    on: 'ligado', off: 'desligado',
    byPreference: 'ligado pela preferência',
    byEnv: (v: string, val: string) => `${v}=${val} definida explicitamente`,
    overridden: (v: string, val: string) => `mantido desligado por ${v}=${val}, que vence a preferência`,
    byDefault: 'desligado por padrão',
    shellNote: 'Lido do ambiente deste shell; uma variável exportada só aqui não é a do servidor.',
    saved: (on: boolean) => `Salvo: experimental ${on ? 'ligado' : 'desligado'}.`,
    nothingRunning: 'Nada está rodando, então nada foi reiniciado — vale na próxima vez que o servidor subir.',
    restarting: 'Reiniciando o serviço em execução…',
    back: 'O servidor voltou e informa o novo estado.',
    notBack: 'O serviço foi reiniciado, mas o servidor não respondeu com o novo estado a tempo. Veja `agentop status`.',
    failed: (m: string) => `O reinício falhou: ${m}`,
  },
} as const

export function statusLines(pref: boolean | undefined, rows: ExperimentalStatus[], lang: CliLang): string[] {
  const t = T[lang]
  const out = [t.header(pref === true)]
  for (const r of rows) {
    const f = EXPERIMENTAL_FEATURES.find(x => x.id === r.id)!
    const why = r.source === 'env'
      ? (r.overridden ? t.overridden(r.env, r.envValue ?? '') : t.byEnv(r.env, r.envValue ?? ''))
      : r.source === 'preference' ? t.byPreference : t.byDefault
    out.push(`  ${r.on ? '●' : '○'} ${r.id.padEnd(12)} ${(r.on ? t.on : t.off).padEnd(10)} ${r.env}`)
    out.push(`      ${f.description[lang]}`)
    out.push(`      ${why}`)
  }
  return out
}

/** The running server's own answer, when there is one (`GET /api/experimental`). */
async function askServer(): Promise<{ enabled: boolean; features: ExperimentalStatus[] } | null> {
  const port = process.env.PORT ?? '47291'
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/experimental`, { signal: AbortSignal.timeout(2000) })
    if (!res.ok) return null
    return await res.json() as { enabled: boolean; features: ExperimentalStatus[] }
  } catch { return null }
}

async function waitForState(enabled: boolean, timeoutMs = 25000): Promise<boolean> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    const r = await askServer()
    if (r && r.enabled === enabled) return true
    await new Promise(res => setTimeout(res, 1000))
  }
  return false
}

export async function runExperimental(args: string[]): Promise<number> {
  const lang = await resolveLang()
  const t = T[lang]
  const verb = args.find(a => !a.startsWith('-'))
  if (verb !== 'enable' && verb !== 'disable' && verb !== 'status') {
    console.error(t.usage)
    return 1
  }
  if (verb === 'status') {
    const live = await askServer()
    if (live) {
      console.log(statusLines(live.enabled, live.features, lang).join('\n'))
      return 0
    }
    const prefs = await readPreferencesOrExit()
    console.log(statusLines(prefs.experimental, resolveExperimental(prefs.experimental, process.env), lang).join('\n'))
    console.log(`\n${t.shellNote}`)
    return 0
  }
  const enabled = verb === 'enable'
  await readPreferencesOrExit()
  await writePreferences({ experimental: enabled })
  console.log(t.saved(enabled))
  const { restartForConfigChange } = await import('./cli-start')
  const r = await restartForConfigChange()
  if (r.state === 'nothing-running') { console.log(t.nothingRunning); return 0 }
  if (r.state === 'failed') { console.error(t.failed(r.message)); return 1 }
  console.log(t.restarting)
  if (await waitForState(enabled)) { console.log(t.back); return 0 }
  console.error(t.notBack)
  return 1
}
