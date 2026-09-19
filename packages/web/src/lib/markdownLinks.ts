/**
 * markdownLinks.ts — PURE: how a rendered markdown document's `a`/`img` targets are classified and
 * resolved, so `MarkdownPreview.tsx` never has to reason about a URL scheme itself.
 *
 * TWO SEPARATE QUESTIONS, because the two elements carry different risk. A LINK is something the
 * reader clicks — an `href` the browser navigates to — so `classifyHref` runs every scheme through
 * an ALLOWLIST (`http`, `https`, `mailto`, `tel`) and answers `'blocked'` for everything else,
 * `javascript:` included: a markdown link is untrusted repository content, and a renderer that opens
 * whatever scheme a file names is a renderer an attacker gets to click through the reader's own
 * session. An IMAGE never executes anything by being shown — the risk there is a NETWORK REQUEST
 * (a remote `<img src>` is a free tracking pixel for anyone who can put a file in the tree — see the
 * design's own security note) — so `classifyImgSrc` only ever separates "safe to embed inline"
 * (a relative repo path, or a `data:` URI that makes no request at all) from "remote", and the
 * caller (`MarkdownPreview`) renders the remote case as a link instead of fetching it.
 *
 * `resolveRepoRelativePath` is the other half: a relative `src`/`href` in a document is relative to
 * THAT DOCUMENT'S OWN DIRECTORY, not to the session's tree root — `./img.png` in `docs/guide.md`
 * names `docs/img.png`. The result is a path relative to the tree root, exactly what
 * `repoMediaUrl(sessionId, path)` (`lib/attachmentUrl.ts`) already expects; this module never builds
 * that URL itself; see its own header for why. Containment (no escaping the session's root) is the
 * SERVER's job on that route, same as every other tree read — this is path arithmetic, not a
 * security boundary of its own.
 */

export type HrefKind = 'internal' | 'external' | 'blocked'
export type ImgSrcKind = 'internal' | 'remote'

const SCHEME = /^([a-z][a-z0-9+.-]*):/i

/** Link schemes safe enough to open in a new tab. Anything else — `javascript:`, `data:`, `file:`,
 * `vbscript:` — is refused outright rather than judged case by case. */
const SAFE_LINK_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'tel:'])

/**
 * Is `href` a scheme this preview may navigate to, a relative repo path, or neither?
 *
 * Protocol-relative (`//host/path`) is treated as `external`: the browser resolves it against the
 * PAGE's own scheme, which on this product is always `https:` — one of the two schemes already
 * allowed — so it carries no more risk than writing `https://host/path` out in full.
 */
export function classifyHref(href: string): HrefKind {
  const h = href.trim()
  if (h === '') return 'blocked'
  if (h.startsWith('//')) return 'external'
  const m = SCHEME.exec(h)
  if (m === null) return 'internal'
  return SAFE_LINK_SCHEMES.has(m[1]!.toLowerCase() + ':') ? 'external' : 'blocked'
}

/**
 * Is `src` embeddable without a network request (a relative repo path, resolved through the media
 * route — or a `data:` URI, which is already fully inline), or does showing it mean fetching
 * something this reader did not ask for?
 */
export function classifyImgSrc(src: string): ImgSrcKind {
  const s = src.trim()
  if (s === '') return 'internal'
  if (s.startsWith('//')) return 'remote'
  const m = SCHEME.exec(s)
  if (m === null) return 'internal'
  return m[1]!.toLowerCase() === 'data' ? 'internal' : 'remote'
}

/** The directory a path sits in — `''` for a root-level file, never a trailing slash. */
function dirOf(path: string): string {
  const idx = path.lastIndexOf('/')
  return idx === -1 ? '' : path.slice(0, idx)
}

/** Collapses `.` and `..` segments. A leading `..` past the joined root is KEPT (not clamped) —
 * containment is the server's job on the read route this feeds; a client-side clamp here would
 * only hide a path that route is going to refuse anyway, which is the "refuse, never repair" rule
 * applied to a component that owns no refusal of its own. */
function normalizeSegments(path: string): string {
  const out: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..' && out.length > 0 && out[out.length - 1] !== '..') out.pop()
    else out.push(part)
  }
  return out.join('/')
}

/** Strips a `#fragment` and/or `?query` off an internal href/src before it is resolved as a path —
 * neither one is part of a repository file's own name. */
function stripSuffix(path: string): string {
  const hash = path.indexOf('#')
  const cut = hash === -1 ? path : path.slice(0, hash)
  const query = cut.indexOf('?')
  return query === -1 ? cut : cut.slice(0, query)
}

/**
 * Resolves a relative `href`/`src` found INSIDE `docPath` into a path relative to the session's
 * tree root. `relPath` starting with `/` is already root-relative (the leading slash is dropped,
 * not treated as a filesystem root the document has no business naming).
 */
export function resolveRepoRelativePath(docPath: string, relPath: string): string {
  const target = stripSuffix(relPath)
  if (target.startsWith('/')) return normalizeSegments(target)
  const dir = dirOf(docPath)
  return normalizeSegments(dir === '' ? target : `${dir}/${target}`)
}
