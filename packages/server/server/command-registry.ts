/**
 * command-registry.ts — the host half of the ONE command registry (B8 spec §5.1, B8.5).
 *
 * The registry itself is runtime data (`@agentistics/runtime`, `commands/`). This module is the
 * only place the host BUILDS it, so every surface reads the same list:
 *
 * - the terminal (`agentop code`, `cli-code.ts`) calls `loadCommands` at session start and on
 *   `/reload`, and prints `commandListing` for `/help`;
 * - the web composer reads `GET /api/runtime/commands` (`commandsRoute`), whose body IS
 *   `commandListing` for the web surface.
 *
 * `command-registry.test.ts` builds one catalogue on disk and asserts the terminal listing and the
 * route body name the same commands in the same order — the test is over the registry, not over
 * two copies of it (spec criterion 8).
 *
 * ## `@path` in a custom command's template
 *
 * The runtime names the references; `resolveFileRefs` reads them under the rules a session's own
 * `file.read` meets without asking: inside the WORKSPACE (after resolving symlinks — a link that
 * points out is refused), never a path the deny floor protects (`floorForPath`), never a
 * secret-shaped file (`.env*`, `*.pem`, `id_*`: the policy would ASK for those, and there is no
 * person to ask at expansion time), a regular file, text, at most `MAX_REF_BYTES`. Anything else is
 * refused in words and the whole expansion is refused with it — the runtime never sends half a
 * message. A command that needs a file outside the workspace names it in words instead; the model
 * can then read it through `file.read`, under the policy, with the person asked.
 */
import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import {
  buildCommandRegistry,
  commandMenu,
  floorForPath,
  secretShaped,
  type CommandRegistry,
  type CommandSentence,
  type CommandSurface,
  type FileRefResolution,
  type MenuItem,
} from '@agentistics/runtime'
import { loadCatalogue, type LoadCatalogueOptions } from './catalogue-host'

export interface LoadedCommands {
  registry: CommandRegistry
  workspaceRoot: string
  projectTrusted: boolean
}

/** The catalogue's in-force command entries, as a registry. The ONE builder every surface uses. */
export async function loadCommands(opts: LoadCatalogueOptions = {}): Promise<LoadedCommands> {
  const loaded = await loadCatalogue(opts)
  const projectTrusted = loaded.trust.state === 'trusted'
  const entries = loaded.items.filter(i => i.status === 'active' && i.entry.kind === 'command').map(i => i.entry)
  return { registry: buildCommandRegistry(entries, { projectTrusted }), workspaceRoot: loaded.roots.workspaceRoot, projectTrusted }
}

/** What `/help` prints and what the web route returns: the menu for one surface, idle. */
export function commandListing(loaded: LoadedCommands, surface: CommandSurface, running = false): MenuItem[] {
  return commandMenu(loaded.registry, { surface, running })
}

const pick = (lang: 'en' | 'pt', s: CommandSentence): string => (lang === 'pt' ? s.pt : s.en)

/** The terminal's `/help`: one line per command, then any sentence about what does not apply. */
export function helpLines(items: readonly MenuItem[], lang: 'en' | 'pt'): string[] {
  const width = Math.max(...items.map(i => `/${i.name}${i.args ? ` ${i.args}` : ''}`.length))
  const out: string[] = []
  for (const i of items) {
    const head = `/${i.name}${i.args ? ` ${i.args}` : ''}`.padEnd(width)
    const tags: string[] = []
    if (i.source !== 'builtin') tags.push(i.source)
    if (i.overridesBuiltin) tags.push(lang === 'pt' ? 'substitui o embutido' : 'replaces the built-in')
    const tag = tags.length > 0 ? ` [${tags.join(', ')}]` : ''
    out.push(`  ${head}  ${lang === 'pt' ? i.pt : i.en}${tag}`)
    if (i.why) out.push(`  ${' '.repeat(width)}  ↳ ${pick(lang, i.why)}`)
    for (const s of i.ignored ?? []) out.push(`  ${' '.repeat(width)}  ↳ ${pick(lang, s)}`)
  }
  return out
}

// ── `@path` ─────────────────────────────────────────────────────────────────────────────────────

export const MAX_REF_BYTES = 64 * 1024

function under(root: string, p: string): boolean {
  const rel = relative(root, p)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && !rel.startsWith(`..${sep}`))
}

function refused(en: string, pt: string): FileRefResolution {
  return { ok: false, why: { en, pt } }
}

export interface ResolveRefsOptions {
  workspaceRoot: string
  /** Relative references resolve against this (the session's cwd). */
  cwd: string
  home: string
  protectedPaths?: readonly string[]
}

/** Reads each `@path` a template named, or says why not. Never throws. */
export async function resolveFileRefs(refs: readonly string[], o: ResolveRefsOptions): Promise<Map<string, FileRefResolution>> {
  const out = new Map<string, FileRefResolution>()
  let root: string
  try { root = await realpath(o.workspaceRoot) } catch { root = o.workspaceRoot }
  const env = { home: o.home, workspaceRoot: root, protectedPaths: o.protectedPaths ?? [] }
  for (const ref of refs) {
    const target = resolve(o.cwd, ref.startsWith('~/') ? `${o.home}/${ref.slice(2)}` : ref)
    let real: string
    try { real = await realpath(target) } catch {
      out.set(ref, refused('the file does not exist.', 'o arquivo não existe.'))
      continue
    }
    if (!under(root, real)) {
      out.set(ref, refused('it is outside the workspace; a command inlines only workspace files.', 'está fora do workspace; um comando só incorpora arquivos do workspace.'))
      continue
    }
    const floor = floorForPath(real, 'read', env)
    if (floor) {
      out.set(ref, refused('the policy floor protects it.', 'o piso da política o protege.'))
      continue
    }
    if (secretShaped(real)) {
      out.set(ref, refused('it looks like a secret, which the policy would ask about; name it in the prompt instead.', 'parece um segredo, sobre o qual a política perguntaria; cite-o no prompt em vez disso.'))
      continue
    }
    try {
      const s = await stat(real)
      if (!s.isFile()) { out.set(ref, refused('it is not a regular file.', 'não é um arquivo comum.')); continue }
      if (s.size > MAX_REF_BYTES) { out.set(ref, refused(`it is larger than ${MAX_REF_BYTES / 1024} KB.`, `é maior que ${MAX_REF_BYTES / 1024} KB.`)); continue }
      const buf = await readFile(real)
      if (buf.includes(0)) { out.set(ref, refused('it is a binary file.', 'é um arquivo binário.')); continue }
      out.set(ref, { ok: true, text: buf.toString('utf8') })
    } catch {
      out.set(ref, refused('it could not be read.', 'não foi possível lê-lo.'))
    }
  }
  return out
}

// ── The web route ───────────────────────────────────────────────────────────────────────────────

export interface CommandsRouteBody {
  surface: CommandSurface
  workspaceRoot: string
  projectTrusted: boolean
  commands: MenuItem[]
}

async function defaultIsCentral(): Promise<boolean> {
  const { TEAM_CENTRAL } = await import('./config')
  if (TEAM_CENTRAL) return true
  try {
    const { readPreferences } = await import('./preferences.ts')
    const mode: string | undefined = (await readPreferences()).team?.mode
    return mode === 'central'
  } catch {
    return false
  }
}

export interface CommandsRouteDeps {
  isCentral?: () => Promise<boolean>
  catalogue?: LoadCatalogueOptions
}

/**
 * `GET /api/runtime/commands?cwd=<dir>` — the list the web composer offers. Registered under
 * `capability-guard.ts`'s `/api/runtime/commands` (`localShell`): it reads the project's
 * `.agentistics` catalogue and the user scope on this host, so it is refused on a central (B8 §8)
 * like every other native-runtime route.
 */
/** A refusal body. The code is a parameter, not a `code: '…'` literal: that shape is what
 *  `notificationCoverage.test.ts` reads as a NOTIFICATION code, and these are route refusals. */
function refuse(status: number, code: string, en: string, pt: string): Response {
  return Response.json({ code, en, pt }, { status })
}

export async function commandsRoute(req: Request, url: URL, deps: CommandsRouteDeps = {}): Promise<Response> {
  if (req.method !== 'GET') {
    return refuse(405, 'method', 'only GET is supported here.', 'só GET é aceito aqui.')
  }
  if (await (deps.isCentral ?? defaultIsCentral)()) {
    return refuse(403, 'central', 'the native runtime does not run on a central.', 'o runtime nativo não roda numa central.')
  }
  const cwd = url.searchParams.get('cwd')
  if (cwd !== null && (!isAbsolute(cwd) || cwd.includes('\0'))) {
    return refuse(400, 'bad_cwd', 'cwd must be an absolute path.', 'cwd deve ser um caminho absoluto.')
  }
  const loaded = await loadCommands({ ...deps.catalogue, ...(cwd !== null ? { cwd } : {}) })
  const body: CommandsRouteBody = {
    surface: 'web',
    workspaceRoot: loaded.workspaceRoot,
    projectTrusted: loaded.projectTrusted,
    commands: commandListing(loaded, 'web'),
  }
  return Response.json(body)
}
