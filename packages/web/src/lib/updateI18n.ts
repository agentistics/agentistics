/**
 * updateI18n.ts — EVERY word the update experience shows (the popup in the Nay window, the bell's
 * sheet, the loader and the finale), in Portuguese and English.
 *
 * Both languages are `Record<UpdateKey, string>`, so a key missing from either is a compile error;
 * `updateI18n.test.ts` adds that every value is non-empty and that each narration phrase is a real
 * translation rather than the same text pasted twice.
 *
 * THE NARRATION IS A POOL, NOT A SCRIPT (owner, 2026-10-02). Each loader step owns several phrases
 * in the Agentistics voice — data streams, a brain, a core, energy — and `pickPhrase` rotates them:
 * a different opening line per update (seeded by the target version) and a new line every few
 * seconds while a step lasts. Adding a phrase is adding a key here, in both languages, and bumping
 * nothing: `PHRASE_KEYS` is derived from the dictionary itself.
 *
 * Owner rule: no surface here names the CLI. Updating in the UI is the button only, and
 * `updateSurfaces.test.ts` fails the build if `agentop upgrade` appears in any of these strings.
 */

import type { Lang } from '@agentistics/core'

export const UPDATE_STEPS = ['data', 'brain', 'wiring', 'power'] as const
export type UpdateStep = (typeof UPDATE_STEPS)[number]

const PT = {
  // the popup / the bell's sheet
  'prompt.eyebrow': 'Nova versão',
  'prompt.title': 'Uma versão nova do Agentistics chegou',
  'prompt.body': 'Instala em segundos, reinicia sozinho e te devolve exatamente aqui. Suas sessões no tmux continuam rodando.',
  'prompt.critical': 'Atualização importante — recomendamos instalar agora.',
  'prompt.install': 'Instalar agora',
  'prompt.later': 'Lembrar mais tarde',
  'prompt.close': 'Fechar',
  'prompt.from_to': 'v{from} → v{to}',
  'prompt.release_notes': 'Ver o que mudou',
  // the loader
  'loader.title': 'Atualizando {pair}',
  'loader.stage_label': 'Etapa {n} de {total}',
  'loader.step.data': 'Download',
  'loader.step.brain': 'Troca do binário',
  'loader.step.wiring': 'Reinício',
  'loader.step.power': 'De volta',
  'loader.keep_open': 'Pode deixar esta aba aberta — ela recarrega sozinha quando a nova versão responder.',
  'loader.failed_title': 'A atualização não terminou',
  'loader.failed_body': 'Nada foi trocado: a versão atual continua funcionando. Você pode tentar de novo.',
  'loader.timeout_title': 'O app precisa reiniciar',
  'loader.timeout_body': 'O app precisa reiniciar para terminar a atualização. Seus trabalhos em andamento continuam rodando.',
  'loader.retry': 'Tentar de novo',
  'loader.restart_now': 'Reiniciar agora',
  'loader.restart_title': 'Falta só reiniciar',
  'loader.restart_body': 'A versão nova já está instalada, mas o app ainda roda a anterior. Reinicie para começar a usá-la — suas sessões continuam rodando.',
  'loader.restart_confirm': 'Reiniciar o Agentistics agora? A página fica fora do ar por alguns segundos e volta sozinha na versão nova.',
  'loader.restart_confirm_yes': 'Sim, reiniciar',
  'loader.cancel': 'Cancelar',
  'loader.reload': 'Recarregar',
  'loader.dismiss': 'Fechar',
  'loader.percent': '{pct}%',
  'loader.mb': '{a} de {b} MB',
  'loader.waiting': 'esperando o servidor voltar',
  // the finale
  'finale.ok': '✓ Atualizado',
  'finale.updated': 'Atualizado {pair}',
  'finale.sub': 'Tudo ligado. Você está de volta onde estava.',
  // the narration pools
  'phrase.data.1': 'Obtendo dados da tecnologia futurística',
  'phrase.data.2': 'Puxando fluxos de dados da nuvem',
  'phrase.data.3': 'Baixando o próximo salto evolutivo',
  'phrase.data.4': 'Sintonizando a frequência da nova versão',
  'phrase.data.5': 'Recolhendo bits espalhados pelo cosmos',
  'phrase.data.6': 'Abrindo um canal direto com o futuro',
  'phrase.brain.1': 'Montando o cérebro do agente',
  'phrase.brain.2': 'Conectando sinapses de silício',
  'phrase.brain.3': 'Encaixando os neurônios novos',
  'phrase.brain.4': 'Conferindo cada circuito, um por um',
  'phrase.brain.5': 'Trocando a peça central com cuidado',
  'phrase.brain.6': 'Calibrando a mente da máquina',
  'phrase.wiring.1': 'Ligando os cabos até o coração central',
  'phrase.wiring.2': 'Religando o núcleo',
  'phrase.wiring.3': 'Roteando energia pelos circuitos',
  'phrase.wiring.4': 'Reconectando os agentes à rede',
  'phrase.wiring.5': 'Acendendo as trilhas até o núcleo',
  'phrase.wiring.6': 'Sincronizando os relógios internos',
  'phrase.power.1': 'Ligando a energia',
  'phrase.power.2': 'Carregando o reator a 100%',
  'phrase.power.3': 'Despertando o agente',
  'phrase.power.4': 'O coração voltou a bater',
  'phrase.power.5': 'Primeira faísca da nova versão',
  'phrase.power.6': 'Tudo aceso, conferindo o pulso',
} as const

export type UpdateKey = keyof typeof PT

const EN: Record<UpdateKey, string> = {
  'prompt.eyebrow': 'New version',
  'prompt.title': 'A new version of Agentistics is here',
  'prompt.body': 'Installs in seconds, restarts itself and brings you right back here. Your tmux sessions keep running.',
  'prompt.critical': 'Important update — we recommend installing it now.',
  'prompt.install': 'Install now',
  'prompt.later': 'Remind me later',
  'prompt.close': 'Close',
  'prompt.from_to': 'v{from} → v{to}',
  'prompt.release_notes': 'See what changed',
  'loader.title': 'Updating {pair}',
  'loader.stage_label': 'Step {n} of {total}',
  'loader.step.data': 'Download',
  'loader.step.brain': 'Binary swap',
  'loader.step.wiring': 'Restart',
  'loader.step.power': 'Back online',
  'loader.keep_open': 'You can leave this tab open — it reloads itself as soon as the new version answers.',
  'loader.failed_title': 'The update did not finish',
  'loader.failed_body': 'Nothing was replaced: the current version keeps working. You can try again.',
  'loader.timeout_title': 'The app needs to restart',
  'loader.timeout_body': 'The app needs to restart to finish the update. Your running work keeps going.',
  'loader.retry': 'Try again',
  'loader.restart_now': 'Restart now',
  'loader.restart_title': 'Only the restart is left',
  'loader.restart_body': 'The new version is already installed, but the app is still running the previous one. Restart to start using it — your sessions keep running.',
  'loader.restart_confirm': 'Restart Agentistics now? The page goes offline for a few seconds and comes back on its own on the new version.',
  'loader.restart_confirm_yes': 'Yes, restart',
  'loader.cancel': 'Cancel',
  'loader.reload': 'Reload',
  'loader.dismiss': 'Close',
  'loader.percent': '{pct}%',
  'loader.mb': '{a} of {b} MB',
  'loader.waiting': 'waiting for the server to come back',
  'finale.ok': '✓ Updated',
  'finale.updated': 'Updated {pair}',
  'finale.sub': 'All systems on. You are right back where you were.',
  'phrase.data.1': 'Fetching data from futuristic technology',
  'phrase.data.2': 'Pulling data streams down from the cloud',
  'phrase.data.3': 'Downloading the next evolutionary leap',
  'phrase.data.4': "Tuning in to the new version's frequency",
  'phrase.data.5': 'Gathering bits scattered across the cosmos',
  'phrase.data.6': 'Opening a direct channel to the future',
  'phrase.brain.1': "Assembling the agent's brain",
  'phrase.brain.2': 'Connecting silicon synapses',
  'phrase.brain.3': 'Slotting in the new neurons',
  'phrase.brain.4': 'Checking every circuit, one by one',
  'phrase.brain.5': 'Swapping the core piece with care',
  'phrase.brain.6': "Calibrating the machine's mind",
  'phrase.wiring.1': 'Running the cables to the central heart',
  'phrase.wiring.2': 'Rebooting the core',
  'phrase.wiring.3': 'Routing energy through the circuits',
  'phrase.wiring.4': 'Reconnecting the agents to the grid',
  'phrase.wiring.5': 'Lighting up the traces to the core',
  'phrase.wiring.6': 'Synchronizing the internal clocks',
  'phrase.power.1': 'Switching on the power',
  'phrase.power.2': 'Charging the reactor to 100%',
  'phrase.power.3': 'Waking the agent up',
  'phrase.power.4': 'The heart is beating again',
  'phrase.power.5': 'First spark of the new version',
  'phrase.power.6': 'All lit up, checking the pulse',
}

export const UPDATE_STRINGS: Record<Lang, Record<UpdateKey, string>> = { pt: PT, en: EN }

/** A word, with `{name}` placeholders filled. An unknown placeholder is left visible, never blanked. */
export function ut(lang: Lang, key: UpdateKey, vars: Record<string, string | number> = {}): string {
  const raw = UPDATE_STRINGS[lang === 'pt' ? 'pt' : 'en'][key]
  return raw.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m))
}

/** Each step's phrase keys, in dictionary order — derived, so a new phrase joins its pool by existing. */
export const PHRASE_KEYS: Record<UpdateStep, UpdateKey[]> = Object.fromEntries(
  UPDATE_STEPS.map(step => [step, (Object.keys(PT) as UpdateKey[]).filter(k => k.startsWith(`phrase.${step}.`))]),
) as Record<UpdateStep, UpdateKey[]>

/** A small stable hash, so one version always opens on the same lines and the next one on others. */
export function versionSeed(version: string): number {
  let h = 2166136261
  for (let i = 0; i < version.length; i++) h = Math.imul(h ^ version.charCodeAt(i), 16777619)
  return h >>> 0
}

/** How long one phrase stays before the next one in its pool takes over. */
export const PHRASE_ROTATE_MS = 3200

/**
 * The phrase to show: the step's pool, entered at a version-seeded offset (each step offset again,
 * so two steps never open on the same index), advanced by `tick` — the count of rotations since the
 * step began.
 */
export function pickPhrase(step: UpdateStep, seed: number, tick: number): UpdateKey {
  const pool = PHRASE_KEYS[step]
  const i = (seed + UPDATE_STEPS.indexOf(step) * 7 + Math.max(0, Math.floor(tick))) % pool.length
  return pool[i]!
}

/**
 * The two versions as one phrase, `v<from> → v<to>`. The surfaces colour the halves (from in orange,
 * to in green), so a string that carries `{pair}` is SPLIT around it by `splitPair` and the pair is
 * rendered between the parts; `ut` fills it as plain text for an aria-label.
 */
export function versionPair(from: string, to: string): string {
  return from ? `v${from} → v${to}` : `v${to}`
}

/** The text before and after `{pair}` in a key — what a surface renders around its coloured pair. */
export function splitPair(lang: Lang, key: UpdateKey): [string, string] {
  const [a = '', b = ''] = UPDATE_STRINGS[lang === 'pt' ? 'pt' : 'en'][key].split('{pair}')
  return [a, b]
}
