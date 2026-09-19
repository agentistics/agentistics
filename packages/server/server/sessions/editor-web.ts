/**
 * editor-web.ts — the routes behind the repository explorer.
 *
 * `capability-guard.ts` has already refused these paths where the exposure profile forbids them
 * (the `/api/fleet` prefix), and `index.ts` applies the user's own `editorEnabled` switch on top
 * before this is ever reached (Task 12). What is left here is resolving the session's directory
 * once per request and turning each `editor-fs.ts` refusal code into a localized sentence — the
 * modules themselves stay language-free, like `shell-web.ts` does for `ShellRefusal`.
 */
import type { StartHost } from '../cli-start'
import type { CliLang } from '../cli-lang'
import {
  createTreeEntry, deleteTreeEntry, listChildren, readTreeFile, readTreeMedia, renameTreeEntry,
  resolveSessionDirectory, searchTree, writeTreeFile,
  type CreateRefusal, type DeleteRefusal, type EntryRefusal, type ReadFileRefusal,
  type ReadMediaRefusal, type RenameRefusal, type TextRefusal, type WriteFileRefusal,
} from './editor-fs'
import { planRange } from './editor-media'
import { safeError } from '../errors'
import { OPAQUE_MEDIA_CSP } from '../response-policy'
import type { SessionDirRefusal } from './editor-directory'

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const DIR_REFUSAL: Record<SessionDirRefusal, { en: string; pt: string }> = {
  'unknown-session': {
    en: 'That session is not in this machine’s list.',
    pt: 'Essa sessão não está na lista desta máquina.',
  },
  'no-cwd': {
    en: 'This session records no folder, so there is nothing to open here.',
    pt: 'Esta sessão não tem uma pasta registrada, então não há o que abrir aqui.',
  },
  'cwd-missing': {
    en: 'This session’s folder no longer exists on disk.',
    pt: 'A pasta desta sessão não existe mais no disco.',
  },
}

/**
 * Everything `editor-fs.ts` can refuse with, across every route in this module, plus the write
 * path's own `'conflict'`. Typed over the exact union (not `Record<string, …>`) so a refusal code
 * added to any of those unions and left out here fails `bun tsc --noEmit` instead of silently
 * surfacing as a raw code where a sentence belongs — the same guarantee `DIR_REFUSAL` above and
 * `shell-web.ts`'s own `REFUSAL: Record<ShellRefusal, …>` already have.
 */
type GenericRefusal =
  | EntryRefusal | ReadFileRefusal | WriteFileRefusal | CreateRefusal | RenameRefusal | DeleteRefusal
  | ReadMediaRefusal | TextRefusal
  | 'conflict'

const GENERIC_REFUSAL: Record<GenericRefusal, { en: string; pt: string }> = {
  escaped: {
    en: 'That path is outside this session’s folder.',
    pt: 'Esse caminho está fora da pasta desta sessão.',
  },
  'not-found': {
    en: 'That path does not exist.',
    pt: 'Esse caminho não existe.',
  },
  'not-a-directory': {
    en: 'That path is a file, not a folder.',
    pt: 'Esse caminho é um arquivo, não uma pasta.',
  },
  'not-a-file': {
    en: 'That path is a folder, not a file.',
    pt: 'Esse caminho é uma pasta, não um arquivo.',
  },
  'already-exists': {
    en: 'Something is already there.',
    pt: 'Já existe algo nesse caminho.',
  },
  'into-itself': {
    en: 'A folder cannot be moved into itself or into a folder inside it.',
    pt: 'Uma pasta não pode ser movida para dentro dela mesma nem de uma pasta dentro dela.',
  },
  'is-root': {
    en: 'That is this session’s folder itself. It cannot be renamed or deleted from here.',
    pt: 'Essa é a própria pasta desta sessão. Ela não pode ser renomeada nem apagada por aqui.',
  },
  'not-empty': {
    en: 'That folder is not empty. Delete it recursively to remove everything inside it.',
    pt: 'Essa pasta não está vazia. Apague recursivamente para remover tudo dentro dela.',
  },
  'name-too-long': {
    en: 'That name is too long for this filesystem.',
    pt: 'Esse nome é longo demais para este sistema de arquivos.',
  },
  'no-permission': {
    en: 'This machine does not have permission to write there.',
    pt: 'Esta máquina não tem permissão para gravar nesse lugar.',
  },
  conflict: {
    en: 'This file changed on disk since it was opened. Review the current version before saving over it.',
    pt: 'Este arquivo mudou no disco desde que foi aberto. Revise a versão atual antes de salvar sobre ela.',
  },
  // The bytes route's own two. Both are reachable only by asking it directly (the pane decides from
  // the READ, which carries the kind and the ceiling, so it never asks for something it was told is
  // not shown) — which is exactly why they must still be sentences: the 'open in a tab' link under a
  // PDF goes to this route, and a file deleted since it was read answers here.
  'not-media': {
    en: 'This file is not an image, a video or a PDF, so it is not displayed here.',
    pt: 'Este arquivo não é uma imagem, um vídeo nem um PDF, então não é exibido aqui.',
  },
  'too-big': {
    en: 'This file is larger than this panel will display.',
    pt: 'Este arquivo é maior do que este painel exibe.',
  },
  // Said on the read AND on the write. It names the likely encodings because "not valid UTF-8" alone
  // sends the reader looking for a broken file, and it says WHY it is not opened, because the only
  // thing this panel could show is a copy with the undecodable characters replaced — and saving that
  // copy is what used to destroy the original bytes.
  'not-utf8': {
    en: 'This file is not UTF-8 text (it may be Latin-1, Windows-1252 or UTF-16), so it is not opened here: '
      + 'the editor would replace the characters it cannot read, and saving would write that over the file. '
      + 'Open it with an editor that knows its encoding.',
    pt: 'Este arquivo não é texto UTF-8 (pode ser Latin-1, Windows-1252 ou UTF-16), então não é aberto aqui: '
      + 'o editor trocaria os caracteres que não consegue ler, e salvar gravaria isso por cima do arquivo. '
      + 'Abra-o num editor que conheça a codificação dele.',
  },
}

/**
 * A genuine STATE conflict — something already there, a non-empty folder, a write that lost the
 * race with a change already on disk, a mutation aimed at the session folder itself, a move asked
 * to make a folder its own ancestor — is 409. Everything else here is 404: the path this request
 * named could not be resolved to anything at all (it escaped the tree, or nothing is there, or it
 * is the wrong kind of entry), which is true regardless of which route asked. Decided once, from
 * the REASON CODE, so the same code can never mean 404 through one door and 409 through another.
 */
const CONFLICT_SHAPED: ReadonlySet<GenericRefusal> = new Set(['already-exists', 'not-empty', 'conflict', 'is-root', 'into-itself'])
/**
 * The one CONTENT-shaped refusal the text routes have: the path resolved perfectly well and the
 * answer is about what is in the file, which is what 415 says (the bytes route's `not-media` below
 * is the same shape). A 404 would send the reader looking for a file that is right there.
 */
const statusFor = (reason: GenericRefusal): number => (
  reason === 'not-utf8' ? 415 : CONFLICT_SHAPED.has(reason) ? 409 : 404
)

/**
 * The two refusals the bytes route adds, which `statusFor`'s 404 would misreport: the path resolved
 * perfectly well and the answer is about its CONTENT (415) or its SIZE (413). Kept as a table beside
 * that rule rather than folded into it — every other route in this module has only the two shapes.
 */
const MEDIA_STATUS: Partial<Record<ReadMediaRefusal, number>> = {
  'not-media': 415,
  'too-big': 413,
}

function sentence(reason: string, lang: CliLang): string {
  const dir = DIR_REFUSAL[reason as SessionDirRefusal]
  if (dir) return dir[lang]
  const generic = GENERIC_REFUSAL[reason as GenericRefusal]
  return generic ? generic[lang] : reason
}

/**
 * The `bad_request` messages, localized like every other refusal in this module. Keyed by which
 * parameters a route needs rather than repeated per call site — several routes need exactly "id
 * and path".
 */
type BadRequestKind = 'id' | 'id-and-path' | 'file-body' | 'entry-fields' | 'rename-fields'

const BAD_REQUEST: Record<BadRequestKind, { en: string; pt: string }> = {
  id: { en: 'id is required', pt: 'id é obrigatório' },
  'id-and-path': { en: 'id and path are required', pt: 'id e path são obrigatórios' },
  'file-body': { en: 'content and mtimeMs are required', pt: 'content e mtimeMs são obrigatórios' },
  'entry-fields': { en: 'id, path and kind are required', pt: 'id, path e kind são obrigatórios' },
  'rename-fields': { en: 'id, from and to are required', pt: 'id, from e to são obrigatórios' },
}

const badRequest = (kind: BadRequestKind, lang: CliLang): Response =>
  json({ ok: false, reason: 'bad_request', message: BAD_REQUEST[kind][lang] }, 400)

/** `null` when the path is not ours, so `index.ts` falls through to its next route. */
/**
 * The routes, behind ONE catch. `index.ts` has no try/catch around this call and the server no
 * `error` handler, so anything a filesystem call threw that `editor-fs.ts` does not map to a refusal
 * code reached the client as the raw exception — whose message carries the absolute host path. Now it
 * is `safeError`'s code plus a correlation ref, and the message goes to the log.
 */
export async function handleEditorTreeRoute(
  req: Request, url: URL, host: StartHost, lang: CliLang,
): Promise<Response | null> {
  try {
    return await routeEditorTree(req, url, host, lang)
  } catch (err) {
    const { body, logLine } = safeError(err, { verbose: false })
    console.error(logLine)
    return json({ ok: false, ...body }, 500)
  }
}

async function routeEditorTree(
  req: Request, url: URL, host: StartHost, lang: CliLang,
): Promise<Response | null> {
  const { pathname } = url

  if (pathname === '/api/fleet/tree' && req.method === 'GET') {
    const id = url.searchParams.get('id')
    if (!id) return badRequest('id', lang)
    const dir = await resolveSessionDirectory(host, id)
    if (!dir.ok) return json({ ok: false, reason: dir.reason, message: sentence(dir.reason, lang) }, 404)
    const listed = await listChildren(dir.dir, url.searchParams.get('path') ?? '')
    if (!listed.ok) {
      return json({ ok: false, reason: listed.reason, message: sentence(listed.reason, lang) }, statusFor(listed.reason))
    }
    return json({ ok: true, children: listed.children })
  }

  if (pathname === '/api/fleet/tree/search' && req.method === 'GET') {
    const id = url.searchParams.get('id')
    if (!id) return badRequest('id', lang)
    const dir = await resolveSessionDirectory(host, id)
    if (!dir.ok) return json({ ok: false, reason: dir.reason, message: sentence(dir.reason, lang) }, 404)
    const result = await searchTree(dir.dir, url.searchParams.get('q') ?? '')
    return json({ ok: true, ...result })
  }

  if (pathname === '/api/fleet/tree/file' && req.method === 'GET') {
    const id = url.searchParams.get('id')
    const path = url.searchParams.get('path')
    if (!id || path === null) return badRequest('id-and-path', lang)
    const dir = await resolveSessionDirectory(host, id)
    if (!dir.ok) return json({ ok: false, reason: dir.reason, message: sentence(dir.reason, lang) }, 404)
    const file = await readTreeFile(dir.dir, path)
    if (!file.ok) {
      return json({ ok: false, reason: file.reason, message: sentence(file.reason, lang) }, statusFor(file.reason))
    }
    return json(file)
  }

  /**
   * THE BYTES of one image, video or PDF in the session's tree — the route that turns the Studio's
   * blanket "binary file" refusal into a rendered file for the three kinds a browser can show.
   *
   * A SECOND ROUTE rather than `/api/fleet/media`, and the reason is the ALLOWLIST, not the headers.
   * That route resolves through `planArtifactRead` — files this session WROTE — and refuses
   * everything else with `not-touched`. The Studio browses the session's whole directory, so the PNG
   * that prompted this (a checked-in asset the session never opened) is exactly the case that route
   * exists to refuse. What IS inherited is the content decision: the same closed table
   * (`artifact-media.ts`), where SVG/HTML/XML are deliberately absent — a repository is full of
   * SVGs, and one served inline from this origin is a document that can carry script.
   *
   * THE POLICY IS `OPAQUE_MEDIA_CSP`, AND IT HAS TO BE THAT EXACT CONSTANT. `handleRequest` stamps
   * the dashboard's own headers on every `/api/` response and SETS rather than appends, so a policy
   * written here is normally replaced — which is what happened to this route and to
   * `/api/fleet/media` alike, both carrying a `default-src 'none'; sandbox` in their source that
   * never once shipped. It was not cosmetic: the baseline's `frame-ancestors vscode-webview:`
   * forbade the dashboard from framing its own PDF, so the pane drew the browser's "cannot display"
   * glyph. `response-policy.ts` is the one-value allowlist that lets this policy through, and
   * `nosniff` still arrives from the baseline for every response here — which is the half that
   * makes the closed content table mean anything.
   *
   * CONTAINMENT IS THE STUDIO'S OWN, BOTH HALVES. `readTreeMedia` goes through `resolveTreePath`'s
   * lexical check and `realContained`'s symlink recheck, like every other function in `editor-fs.ts`
   * — never one without the other.
   *
   * IT STREAMS. `Bun.file` is handed to the `Response` rather than read into a buffer, and a
   * `Range` request is answered with a slice of it, which is what makes a video seekable and what
   * makes a 512 MB ceiling something other than 512 MB of server memory. `/api/fleet/media` reads
   * its file whole; at its 12 MB ceiling that is a choice, at this one it would be a defect.
   */
  if (pathname === '/api/fleet/tree/media' && req.method === 'GET') {
    const id = url.searchParams.get('id')
    const path = url.searchParams.get('path')
    if (!id || path === null) return badRequest('id-and-path', lang)
    const dir = await resolveSessionDirectory(host, id)
    if (!dir.ok) return json({ ok: false, reason: dir.reason, message: sentence(dir.reason, lang) }, 404)
    const found = await readTreeMedia(dir.dir, path)
    if (!found.ok) {
      return json(
        { ok: false, reason: found.reason, message: sentence(found.reason, lang) },
        MEDIA_STATUS[found.reason] ?? statusFor(found.reason),
      )
    }

    const headers: Record<string, string> = {
      'Content-Type': found.mime,
      // The one policy `handleRequest` will not replace — see the note above and `response-policy.ts`.
      'Content-Security-Policy': OPAQUE_MEDIA_CSP,
      // Named for all three kinds, not only the PDF: the strip above the pane carries an "Open in a
      // tab" link for every one of them, and a tab that is then saved should not offer `media` as a
      // filename. The name is sanitised because it goes into a quoted header value.
      'Content-Disposition': `inline; filename="${found.name.replace(/[^\w.-]/g, '_')}"`,
      // The file is one a session is actively working on; a cached copy would show the old one.
      'Cache-Control': 'no-store',
      // Stated even on a full response: a media element asks for ranges only once it is told it may.
      'Accept-Ranges': 'bytes',
    }

    const range = planRange(req.headers.get('range'), found.size)
    if (range.kind === 'unsatisfiable') {
      return new Response(null, {
        status: 416,
        headers: { ...headers, 'Content-Range': `bytes */${found.size}` },
      })
    }
    const file = Bun.file(found.real)
    if (range.kind === 'partial') {
      return new Response(file.slice(range.start, range.end + 1), {
        status: 206,
        headers: {
          ...headers,
          'Content-Range': `bytes ${range.start}-${range.end}/${found.size}`,
          'Content-Length': String(range.end - range.start + 1),
        },
      })
    }
    return new Response(file, { headers: { ...headers, 'Content-Length': String(found.size) } })
  }

  if (pathname === '/api/fleet/tree/file' && req.method === 'PUT') {
    const id = url.searchParams.get('id')
    const path = url.searchParams.get('path')
    if (!id || path === null) return badRequest('id-and-path', lang)
    const body = await req.json().catch(() => null) as { content?: string; mtimeMs?: number } | null
    if (!body || typeof body.content !== 'string' || typeof body.mtimeMs !== 'number') {
      return badRequest('file-body', lang)
    }
    const dir = await resolveSessionDirectory(host, id)
    if (!dir.ok) return json({ ok: false, reason: dir.reason, message: sentence(dir.reason, lang) }, 404)
    const out = await writeTreeFile(dir.dir, path, body.content, body.mtimeMs)
    if (!out.ok) return json({ ...out, message: sentence(out.reason, lang) }, statusFor(out.reason))
    return json(out)
  }

  if (pathname === '/api/fleet/tree/entry' && req.method === 'POST') {
    const body = await req.json().catch(() => null) as { id?: string; path?: string; kind?: string } | null
    if (!body?.id || !body.path || (body.kind !== 'file' && body.kind !== 'dir')) {
      return badRequest('entry-fields', lang)
    }
    const dir = await resolveSessionDirectory(host, body.id)
    if (!dir.ok) return json({ ok: false, reason: dir.reason, message: sentence(dir.reason, lang) }, 404)
    const out = await createTreeEntry(dir.dir, body.path, body.kind)
    if (!out.ok) {
      return json({ ok: false, reason: out.reason, message: sentence(out.reason, lang) }, statusFor(out.reason))
    }
    return json(out)
  }

  if (pathname === '/api/fleet/tree/entry' && req.method === 'PATCH') {
    const body = await req.json().catch(() => null) as { id?: string; from?: string; to?: string } | null
    if (!body?.id || !body.from || !body.to) {
      return badRequest('rename-fields', lang)
    }
    const dir = await resolveSessionDirectory(host, body.id)
    if (!dir.ok) return json({ ok: false, reason: dir.reason, message: sentence(dir.reason, lang) }, 404)
    const out = await renameTreeEntry(dir.dir, body.from, body.to)
    if (!out.ok) {
      return json({ ok: false, reason: out.reason, message: sentence(out.reason, lang) }, statusFor(out.reason))
    }
    return json(out)
  }

  if (pathname === '/api/fleet/tree/entry' && req.method === 'DELETE') {
    const id = url.searchParams.get('id')
    const path = url.searchParams.get('path')
    if (!id || path === null) return badRequest('id-and-path', lang)
    const dir = await resolveSessionDirectory(host, id)
    if (!dir.ok) return json({ ok: false, reason: dir.reason, message: sentence(dir.reason, lang) }, 404)
    const recursive = url.searchParams.get('recursive') === '1'
    const out = await deleteTreeEntry(dir.dir, path, recursive)
    if (!out.ok) {
      return json({ ok: false, reason: out.reason, message: sentence(out.reason, lang) }, statusFor(out.reason))
    }
    return json(out)
  }

  return null
}
