/**
 * commands/builtins.ts — the built-in `/commands` as RUNTIME DATA (B8 spec §5.1, B8.5).
 *
 * A built-in is `{ name, description, params, availability, handlerId }`. The runtime says which
 * verbs exist and what their arguments are; the HOST owns what each one does (D23), keyed by
 * `handlerId`. Every surface — the terminal (`agentop code`, and later the Code tab) and the web
 * composer — reads this ONE list through `buildCommandRegistry`: one gesture implemented twice is
 * the defect `task-reopen.ts` exists to have fixed once.
 *
 * The names are the matrix's candidate list (`/help /new /resume /exit /undo /cost /context
 * /permissions /profile /trust /catalogue /reload`) plus `/untrust` (B8 §4) and the three the TUI
 * design spec §3 adds (`/editor` CD-17, `/history` CD-18, `/copy` CD-19). UI.6 may rename them;
 * renaming is an edit HERE and nowhere else.
 *
 * ## Every built-in is PERSON-only (round-3 spec §9 row 3)
 *
 * `invokableBy: 'person'` is the only value there is. No tool, no model call and no relayed central
 * action reaches this list: a command is something a person TYPES. The field exists so a later
 * model-invocable class has to be added on purpose, never by drift.
 *
 * PURE: data and small predicates only.
 */

import { CATALOGUE_KINDS, type CatalogueEntry } from '../catalogue/types.ts'

/** Where a command can be typed. */
export type CommandSurface = 'terminal' | 'web'

export const COMMAND_SURFACES: readonly CommandSurface[] = ['terminal', 'web']

/** The host-side handler each built-in dispatches to. A surface that has none says so in words. */
export type BuiltinHandlerId =
  | 'help' | 'new' | 'resume' | 'exit' | 'undo' | 'cost' | 'context' | 'permissions' | 'profile'
  | 'trust' | 'untrust' | 'catalogue' | 'reload' | 'editor' | 'history' | 'copy'

/** A typed parameter. Values are TEXT tokens validated into their type; nothing is ever evaluated. */
export type CommandParam =
  | { name: string; type: 'text'; required: boolean; en: string; pt: string }
  | { name: string; type: 'enum'; values: readonly string[]; required: boolean; en: string; pt: string }

export interface CommandAvailability {
  /** The surfaces that can run it. `/editor` needs a terminal to suspend into. */
  surfaces: readonly CommandSurface[]
  /** Refused while a turn is running: it changes what the turn runs under or leaves it. */
  idleOnly: boolean
}

export interface BuiltinCommand {
  name: string
  handlerId: BuiltinHandlerId
  en: string
  pt: string
  params: readonly CommandParam[]
  availability: CommandAvailability
  invokableBy: 'person'
}

const BOTH: readonly CommandSurface[] = COMMAND_SURFACES
const TERMINAL: readonly CommandSurface[] = ['terminal']

function b(
  name: BuiltinHandlerId,
  en: string,
  pt: string,
  opts: { params?: CommandParam[]; surfaces?: readonly CommandSurface[]; idleOnly?: boolean } = {},
): BuiltinCommand {
  return {
    name,
    handlerId: name,
    en,
    pt,
    params: opts.params ?? [],
    availability: { surfaces: opts.surfaces ?? BOTH, idleOnly: opts.idleOnly ?? false },
    invokableBy: 'person',
  }
}

/** The built-ins, in the order a listing shows them. */
export const BUILTIN_COMMANDS: readonly BuiltinCommand[] = [
  b('help', 'List every command and what it does.', 'Lista todos os comandos e o que cada um faz.'),
  b('new', 'Start a new session in this folder.', 'Inicia uma nova sessão nesta pasta.', { idleOnly: true }),
  b('resume', 'Reopen an earlier session.', 'Reabre uma sessão anterior.', {
    idleOnly: true,
    params: [{ name: 'session', type: 'text', required: false, en: 'the session id; absent lists the recent ones', pt: 'o id da sessão; sem ele lista as recentes' }],
  }),
  b('exit', 'Leave the session.', 'Sai da sessão.', { surfaces: TERMINAL }),
  b('undo', 'Revert the files the last turn changed.', 'Desfaz os arquivos que o último turno alterou.', { idleOnly: true }),
  b('cost', 'What this session has spent, turn by turn.', 'Quanto esta sessão gastou, turno a turno.'),
  b('context', 'How full the context window is, and with what.', 'Quão cheia está a janela de contexto, e com o quê.'),
  b('permissions', 'The rules in force and the answers remembered for this session.', 'As regras em vigor e as respostas lembradas nesta sessão.'),
  b('profile', 'Show or switch the permission profile.', 'Mostra ou troca o perfil de permissão.', {
    idleOnly: true,
    params: [{ name: 'name', type: 'text', required: false, en: 'the profile to switch to; absent shows the current one', pt: 'o perfil para o qual trocar; sem ele mostra o atual' }],
  }),
  b('trust', "Trust this folder's project configuration.", 'Confia na configuração de projeto desta pasta.', { idleOnly: true }),
  b('untrust', "Revoke this folder's trust and everything it earned.", 'Revoga a confiança desta pasta e tudo o que ela concedeu.', { idleOnly: true }),
  b('catalogue', 'What is installed: commands, skills, agents, servers, profiles.', 'O que está instalado: comandos, skills, agentes, servidores, perfis.', {
    params: [{ name: 'kind', type: 'enum', values: CATALOGUE_KINDS, required: false, en: 'only this kind', pt: 'só este tipo' }],
  }),
  b('reload', 'Read the catalogue again from disk.', 'Lê o catálogo de novo do disco.', { idleOnly: true }),
  b('editor', 'Write the prompt in $EDITOR.', 'Escreve o prompt no $EDITOR.', { surfaces: TERMINAL, idleOnly: true }),
  b('history', 'Earlier prompts on this machine, newest first.', 'Prompts anteriores nesta máquina, mais recentes primeiro.'),
  b('copy', 'Copy the last finished answer.', 'Copia a última resposta concluída.'),
]

export function builtinCommand(name: string): BuiltinCommand | undefined {
  return BUILTIN_COMMANDS.find(c => c.name === name)
}

/**
 * The built-ins as catalogue entries, for `resolveCatalogue`: their NAMES are what B8.1's
 * precedence rule 3 protects, so a repository's `commands/undo.md` is refused and a user's needs
 * `override: true`. The host passes these as its `builtins` instead of restating the list.
 */
export function builtinCommandEntries(): CatalogueEntry<'command'>[] {
  return BUILTIN_COMMANDS.map(c => ({
    kind: 'command',
    name: c.name,
    scope: 'builtin',
    source: {},
    enabled: true,
    trust: 'n/a',
    problems: [],
    def: { description: c.en, template: '' },
  }))
}
