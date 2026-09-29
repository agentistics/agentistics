/**
 * catalogue-host.ts — the IO half of the native harness catalogue (B8.2, spec §6). It walks the
 * scope directories, reads TEXT and hands it to `catalogue-plan.ts`, which hands it to B8.1's pure
 * parsers. No rule about what an entry means lives here; what lives here is what only the host can
 * know — where each scope is, what it is safe to read, and this machine's real floor.
 *
 * | scope    | where                                                      |
 * |----------|------------------------------------------------------------|
 * | builtin  | supplied by the host (`HOST_BUILTINS`, decision 9)         |
 * | user     | `<AGENTISTICS_DIR>/harness/` (`USER_HARNESS_DIR`)          |
 * | project  | `<workspaceRoot>/.agentistics/`                            |
 * | compat   | `~/.claude/skills`, `~/.agents/skills` — only when the USER settings opt in (C6) |
 *
 * ## What is refused before anything is read
 *
 * - **A project file that resolves OUTSIDE the project's own directory.** A repository can ship
 *   `commands/x.md` as a symlink to `~/.aws/credentials`; reading it would put a credential into a
 *   command template the model then reads. It is listed, disabled, with the sentence — never read.
 * - **A file over `MAX_FILE_BYTES`.** A catalogue file is prompt text; a large one is a mistake, and
 *   reading it whole on every load is a cost nobody asked for.
 * - **A project scope that IS this machine's data directory.** Run from `$HOME` outside any
 *   repository, `<workspaceRoot>/.agentistics` is `~/.agentistics` itself — agentistics' own data,
 *   not a project catalogue. The scope is skipped and a notice says so.
 *
 * Everything else found in a scope directory and not understood is a NOTICE with a sentence: a file
 * silently ignored is a file its author believes is in force.
 *
 * Listing order never decides anything: every directory read is sorted.
 */
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import type { CatalogueEntry, CatalogueScope, FloorEnv } from '@agentistics/runtime'
import { AGENTISTICS_DATA_DIR, DEFAULT_AGENTISTICS_DATA_DIR, HOME_DIR } from './config'
import {
  planCatalogue,
  settingsOutcome,
  type CatalogueNotice,
  type CatalogueRecord,
  type CatalogueView,
  type RecordKind,
  UNREADABLE,
} from './catalogue-plan'
import { hostFloorEnv, workspaceRootFor } from './runtime-host'

/** The user scope. Carried by backups: `backup-plan.ts` ALWAYS. */
export const USER_HARNESS_DIR = join(AGENTISTICS_DATA_DIR, 'harness')
/** A project's scope directory, under its workspace root. */
export const PROJECT_DIR_NAME = '.agentistics'
export const MAX_FILE_BYTES = 256 * 1024

/**
 * Built-in entries (decision 9). Only what EXISTS today: `agentop code` answers `/exit` itself
 * (`cli-code.ts`), so a repository must not be able to define a command of that name. The rest of
 * the built-in list is UI.6's call and the command registry's (B8.5); built-in profiles and agents
 * are B8.4 / B8.7.
 */
export const HOST_BUILTINS: readonly CatalogueEntry[] = [
  {
    kind: 'command', name: 'exit', scope: 'builtin', source: {}, enabled: true, trust: 'n/a', problems: [],
    def: { description: 'Leave the session.', template: '' },
  },
]

/** Names a scope directory may hold that are not read here but are not unknown either. */
const RESERVED_TOP = new Set([
  'harness.lock.json', // B8.10's lockfile
  'orchestrations',    // round-3 spec §9 row 5 (ORC.8)
  'artifacts',         // round-3 spec §9 row 5 (ART.2)
])

export interface LoadCatalogueOptions {
  /** Where the person is. Default: `process.cwd()`. */
  cwd?: string
  /** Default: the git toplevel of `cwd` (`workspaceRootFor`). */
  workspaceRoot?: string
  home?: string
  /** The data dir in use. Default `AGENTISTICS_DATA_DIR`. */
  dataDir?: string
  defaultDataDir?: string
  /** Default `<dataDir>/harness`. */
  userDir?: string
  compatDirs?: { claudeSkills: string; agentsSkills: string }
  protectedPaths?: readonly string[]
  builtins?: readonly CatalogueEntry[]
}

export interface LoadedCatalogue extends CatalogueView {
  roots: {
    workspaceRoot: string
    user: string
    project: string | null
    compat: string[]
  }
  floorEnv: FloorEnv
}

function notice(scope: CatalogueScope, path: string, code: string, en: string, pt: string): CatalogueNotice {
  return { scope, path, code, en, pt }
}

async function sortedDir(dir: string): Promise<Array<{ name: string; isDir: boolean; isFile: boolean }> | null> {
  try {
    const ents = await readdir(dir, { withFileTypes: true })
    const out: Array<{ name: string; isDir: boolean; isFile: boolean }> = []
    for (const e of ents) {
      let isDir = e.isDirectory()
      let isFile = e.isFile()
      if (e.isSymbolicLink()) {
        try { const s = await stat(join(dir, e.name)); isDir = s.isDirectory(); isFile = s.isFile() } catch { /* dangling: neither */ }
      }
      out.push({ name: e.name, isDir, isFile })
    }
    return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  } catch {
    return null
  }
}

function inside(root: string, p: string): boolean {
  const r = relative(root, p)
  return r === '' || (!r.startsWith('..') && !r.startsWith(sep) && r !== '..')
}

interface ReadCtx {
  scope: CatalogueScope
  /** Realpath the file must resolve inside, when set (project scope). */
  containRoot: string | null
}

/** Reads one file as text, or says why not. Never throws. */
async function readText(path: string, ctx: ReadCtx): Promise<{ text: string } | { refusal: { code: string; en: string; pt: string } }> {
  try {
    if (ctx.containRoot !== null) {
      const real = await realpath(path)
      if (!inside(ctx.containRoot, real)) {
        return { refusal: {
          code: 'catalogue.outside-project',
          en: 'this file resolves outside the project\'s .agentistics directory (a symlink), so it is not read: a repository may not hand the agent a file from elsewhere on this machine.',
          pt: 'este arquivo aponta para fora do diretório .agentistics do projeto (um symlink), então não é lido: um repositório não pode entregar ao agente um arquivo de outro lugar desta máquina.',
        } }
      }
    }
    const s = await stat(path)
    if (s.size > MAX_FILE_BYTES) {
      return { refusal: {
        code: 'catalogue.too-large',
        en: `the file is ${s.size} bytes; a catalogue file may be at most ${MAX_FILE_BYTES}, so it is not read.`,
        pt: `o arquivo tem ${s.size} bytes; um arquivo de catálogo pode ter no máximo ${MAX_FILE_BYTES}, então não é lido.`,
      } }
    }
    return { text: await readFile(path, 'utf-8') }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'EIO'
    return { refusal: {
      code: UNREADABLE,
      en: `the file could not be read (${code}).`,
      pt: `o arquivo não pôde ser lido (${code}).`,
    } }
  }
}

async function record(scope: CatalogueScope, kind: RecordKind, path: string, name: string, ctx: ReadCtx): Promise<CatalogueRecord> {
  const r = await readText(path, ctx)
  return 'text' in r ? { scope, kind, path, name, text: r.text } : { scope, kind, path, name, text: null, refusal: r.refusal }
}

/** One `.md` / `.json` directory of named files (commands, agents, profiles). */
async function namedFiles(
  dir: string, ext: '.md' | '.json', kind: RecordKind, ctx: ReadCtx,
  records: CatalogueRecord[], notices: CatalogueNotice[],
): Promise<void> {
  const list = await sortedDir(dir)
  if (!list) return
  for (const e of list) {
    if (e.name.startsWith('.')) continue
    const path = join(dir, e.name)
    if (e.isFile && e.name.endsWith(ext)) {
      records.push(await record(ctx.scope, kind, path, e.name.slice(0, -ext.length), ctx))
    } else {
      notices.push(notice(ctx.scope, path, 'catalogue.unrecognised-file',
        `not read: only ${ext} files are ${kind === 'permissionProfile' ? 'profiles' : `${kind}s`} here.`,
        `não lido: aqui só arquivos ${ext} são ${kind === 'permissionProfile' ? 'perfis' : kind === 'command' ? 'comandos' : 'agentes'}.`))
    }
  }
}

/** `skills/<name>/SKILL.md`. A skill directory with no SKILL.md is still listed, disabled. */
async function skillDirs(dir: string, ctx: ReadCtx, records: CatalogueRecord[], notices: CatalogueNotice[]): Promise<void> {
  const list = await sortedDir(dir)
  if (!list) return
  for (const e of list) {
    if (e.name.startsWith('.')) continue
    const path = join(dir, e.name)
    if (!e.isDir) {
      notices.push(notice(ctx.scope, path, 'catalogue.unrecognised-file',
        'not read: a skill is a directory holding SKILL.md.',
        'não lido: uma skill é um diretório contendo SKILL.md.'))
      continue
    }
    const md = join(path, 'SKILL.md')
    const has = await stat(md).then(s => s.isFile()).catch(() => false)
    if (has) records.push(await record(ctx.scope, 'skill', md, e.name, ctx))
    else records.push({
      scope: ctx.scope, kind: 'skill', path: md, name: e.name, text: null,
      refusal: {
        code: 'catalogue.skill-missing',
        en: 'this skill directory has no SKILL.md; add one with `name:` and `description:`.',
        pt: 'este diretório de skill não tem SKILL.md; adicione um com `name:` e `description:`.',
      },
    })
  }
}

/** A user or project scope directory, laid out as spec §3.3 says. */
async function walkScope(root: string, ctx: ReadCtx, records: CatalogueRecord[], notices: CatalogueNotice[]): Promise<void> {
  const top = await sortedDir(root)
  if (!top) return
  for (const e of top) {
    const path = join(root, e.name)
    if (e.name === 'settings.json' && e.isFile) records.push(await record(ctx.scope, 'settings', path, 'settings', ctx))
    else if (e.name === 'commands' && e.isDir) await namedFiles(path, '.md', 'command', ctx, records, notices)
    else if (e.name === 'agents' && e.isDir) await namedFiles(path, '.md', 'agent', ctx, records, notices)
    else if (e.name === 'profiles' && e.isDir) await namedFiles(path, '.json', 'permissionProfile', ctx, records, notices)
    else if (e.name === 'skills' && e.isDir) await skillDirs(path, ctx, records, notices)
    else if (RESERVED_TOP.has(e.name) || e.name.startsWith('.')) continue
    else notices.push(notice(ctx.scope, path, 'catalogue.unrecognised-file',
      'not read: a catalogue directory holds settings.json, commands/, skills/, agents/ and profiles/.',
      'não lido: um diretório de catálogo contém settings.json, commands/, skills/, agents/ e profiles/.'))
  }
}

async function realOrSelf(p: string): Promise<string> {
  try { return await realpath(p) } catch { return p }
}

/**
 * Loads the catalogue in force for a workspace. Reads the USER settings first: whether the compat
 * directories are read at all is the person's opt-in there (C6), judged AFTER the file-secret rule.
 */
export async function loadCatalogue(opts: LoadCatalogueOptions = {}): Promise<LoadedCatalogue> {
  const home = opts.home ?? HOME_DIR
  const dataDir = opts.dataDir ?? AGENTISTICS_DATA_DIR
  const cwd = opts.cwd ?? process.cwd()
  const workspaceRoot = opts.workspaceRoot ?? workspaceRootFor(cwd)
  const userDir = opts.userDir ?? join(dataDir, 'harness')
  const compatDirs = opts.compatDirs ?? { claudeSkills: join(home, '.claude', 'skills'), agentsSkills: join(home, '.agents', 'skills') }
  const floorEnv = hostFloorEnv(workspaceRoot, {
    home, dataDir,
    ...(opts.defaultDataDir !== undefined ? { defaultDataDir: opts.defaultDataDir } : { defaultDataDir: DEFAULT_AGENTISTICS_DATA_DIR }),
    ...(opts.protectedPaths !== undefined ? { protectedPaths: opts.protectedPaths } : {}),
  })

  const records: CatalogueRecord[] = []
  const notices: CatalogueNotice[] = []

  // user
  await walkScope(userDir, { scope: 'user', containRoot: null }, records, notices)

  // project
  let projectDir: string | null = join(workspaceRoot, PROJECT_DIR_NAME)
  const [realProject, realData, realUser] = await Promise.all([realOrSelf(projectDir), realOrSelf(dataDir), realOrSelf(userDir)])
  if (inside(realData, realProject) || inside(realProject, realData) || inside(realProject, realUser)) {
    notices.push(notice('project', projectDir, 'catalogue.project-is-data-dir',
      `the workspace's .agentistics directory is agentistics' own data directory (${dataDir}), not a project catalogue, so no project scope is read here.`,
      `o diretório .agentistics do workspace é o próprio diretório de dados do agentistics (${dataDir}), não um catálogo de projeto, então nenhum escopo de projeto é lido aqui.`))
    projectDir = null
  } else {
    await walkScope(projectDir, { scope: 'project', containRoot: realProject }, records, notices)
  }

  // compat — only what the person opted into, in their USER settings
  const userSettings = records.find(r => r.scope === 'user' && r.kind === 'settings')
  const compat = userSettings ? settingsOutcome(userSettings, floorEnv).view.settings.compat ?? {} : {}
  const compatRead: string[] = []
  for (const key of ['claudeSkills', 'agentsSkills'] as const) {
    if (compat[key] !== true) continue
    compatRead.push(compatDirs[key])
    await skillDirs(compatDirs[key], { scope: 'compat', containRoot: null }, records, notices)
  }

  const homeRel = relative(home, userDir)
  const userRoot = homeRel !== '' && !homeRel.startsWith('..') ? { abs: userDir, homeRel } : undefined
  const view = planCatalogue({
    records, notices, builtins: opts.builtins ?? HOST_BUILTINS, floorEnv,
    ...(userRoot ? { userRoot } : {}),
  })
  return { ...view, roots: { workspaceRoot, user: userDir, project: projectDir, compat: compatRead }, floorEnv }
}
