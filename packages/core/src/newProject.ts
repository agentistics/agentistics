/**
 * newProject.ts — PURE: the rules for "Novo projeto" in the new-session wizard.
 *
 * PROTOTYPE (t-eab4751cb3). Shared by the browser (inline validation, the default location) and by
 * the server (which re-checks every rule before it creates anything), so the two can never disagree
 * about what a valid name is.
 *
 * The name is a FOLDER name a non-technical person types. It is kept as typed (spaces and accents
 * included) — every assistant CLI takes a cwd with spaces — and refused only for what no file system
 * of the three we run on accepts, or what would escape the chosen parent.
 */

export type ProjectNameRefusal =
  | 'empty'
  | 'too-long'
  | 'separator'
  | 'reserved-char'
  | 'dot-name'
  | 'edge-space-or-dot'
  | 'windows-reserved'

export type ProjectNameCheck = { ok: true; name: string } | { ok: false; reason: ProjectNameRefusal }

/** 64 is far under every file system's 255, and a name longer than this is a sentence, not a name. */
export const PROJECT_NAME_MAX = 64

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i
// eslint-disable-next-line no-control-regex
const RESERVED_CHARS = /[<>:"|?*\x00-\x1f]/

export function checkProjectName(raw: string): ProjectNameCheck {
  const name = raw.normalize('NFC')
  if (name.trim() === '') return { ok: false, reason: 'empty' }
  if (name.length > PROJECT_NAME_MAX) return { ok: false, reason: 'too-long' }
  if (/[\\/]/.test(name)) return { ok: false, reason: 'separator' }
  if (RESERVED_CHARS.test(name)) return { ok: false, reason: 'reserved-char' }
  if (name === '.' || name === '..') return { ok: false, reason: 'dot-name' }
  // Windows silently strips a trailing dot or space, so "app." and "app" would be one folder there.
  if (/^\s|\s$|\.$/.test(name)) return { ok: false, reason: 'edge-space-or-dot' }
  if (WINDOWS_RESERVED.test(name)) return { ok: false, reason: 'windows-reserved' }
  return { ok: true, name }
}

/** The sentence for each refusal — said under the field, never as a disabled button with no why. */
export function projectNameMessage(reason: ProjectNameRefusal | 'exists' | 'forbidden' | 'parent-missing' | 'failed', pt: boolean): string {
  switch (reason) {
    case 'empty': return pt ? 'Dê um nome ao projeto.' : 'Give the project a name.'
    case 'too-long': return pt ? `Nome longo demais — até ${PROJECT_NAME_MAX} caracteres.` : `Name too long — up to ${PROJECT_NAME_MAX} characters.`
    case 'separator': return pt ? 'O nome não pode ter / nem \\ — escolha o local em "Onde criar".' : 'The name cannot contain / or \\ — pick the place under "Create in".'
    case 'reserved-char': return pt ? 'O nome não pode ter < > : " | ? *' : 'The name cannot contain < > : " | ? *'
    case 'dot-name': return pt ? 'Esse nome não é permitido.' : 'That name is not allowed.'
    case 'edge-space-or-dot': return pt ? 'O nome não pode começar ou terminar com espaço, nem terminar com ponto.' : 'The name cannot start or end with a space, or end with a dot.'
    case 'windows-reserved': return pt ? 'Esse nome é reservado pelo Windows. Escolha outro.' : 'Windows reserves that name. Pick another.'
    case 'exists': return pt ? 'Já existe uma pasta com esse nome aqui.' : 'A folder with that name already exists here.'
    case 'forbidden': return pt ? 'Não posso criar pastas nesse local.' : 'I cannot create folders in that place.'
    case 'parent-missing': return pt ? 'O local escolhido não existe mais. Escolha outro.' : 'The chosen place no longer exists. Pick another.'
    case 'failed': return pt ? 'Não consegui criar a pasta. Tente de novo.' : 'I could not create the folder. Try again.'
  }
}

/**
 * Where a new project goes by default: the folder that already holds the MOST of this person's
 * projects (their own habit, read off the list the wizard already has), as long as it is not the home
 * itself; else `<home>/projetos` (pt) or `<home>/projects` (en), created along with the project.
 */
export function defaultProjectParent(home: string, projectPaths: readonly string[], pt: boolean): { path: string; exists: boolean } {
  const sep = home.includes('\\') && !home.includes('/') ? '\\' : '/'
  const h = home.replace(/[\\/]+$/, '')
  const counts = new Map<string, number>()
  for (const p of projectPaths) {
    const parent = p.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]+$/, '')
    if (!parent || parent === h || !parent.startsWith(`${h}${sep}`)) continue
    counts.set(parent, (counts.get(parent) ?? 0) + 1)
  }
  let best: string | null = null
  let n = 1
  for (const [k, v] of counts) if (v > n || (v === n && best !== null && k < best)) { best = k; n = v }
  if (best) return { path: best, exists: true }
  return { path: `${h}${sep}${pt ? 'projetos' : 'projects'}`, exists: false }
}

/** `parent` + `name` with the parent's own separator. */
export function joinProjectPath(parent: string, name: string): string {
  const sep = parent.includes('\\') && !parent.includes('/') ? '\\' : '/'
  return `${parent.replace(/[\\/]+$/, '')}${sep}${name}`
}

/**
 * The search box doubles as the name: a query that is a plain name (no path, no match) is offered as
 * "create a project called …". A path-looking query is the search's own escape hatch and never a name.
 */
export function nameFromQuery(query: string): string | null {
  const q = query.trim()
  if (!q || /^[~/\\]|^[a-z]:/i.test(q)) return null
  return checkProjectName(q).ok ? q : null
}
