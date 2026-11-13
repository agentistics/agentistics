/**
 * delivery/capture.ts — `agentop evidence capture <url> [--out f]` (spec §3.1 `api-capture`, §3.4).
 *
 * Produces EXACTLY the shape the `api-capture` validator accepts: a request line, a status line, a few response headers, a
 * blank line and a non-empty body, UTF-8, ≤ 1 MB. It is run by the worker inside its own `agentop run` throwaway, against its
 * own server; the capture proves nothing by itself — the server re-validates the bytes, hashes them and binds them to the
 * verified commit when they are attached.
 */
import { writeFile } from 'node:fs/promises'
import { API_CAPTURE_MAX_BYTES, validateApiCapture } from './evidence'

export interface CaptureInput { method: string; url: string; status: number; statusText: string; headers: Array<[string, string]>; body: string }

const KEEP = ['content-type', 'content-length', 'cache-control', 'etag']

/** PURE: the capture text. */
export function formatCapture(c: CaptureInput): string {
  const u = new URL(c.url)
  const head = c.headers.filter(([k]) => KEEP.includes(k.toLowerCase())).map(([k, v]) => `${k.toLowerCase()}: ${v}`)
  return `${c.method} ${u.pathname}${u.search} HTTP/1.1\nhost: ${u.host}\n\nHTTP/1.1 ${c.status} ${c.statusText}\n${head.join('\n')}${head.length ? '\n' : ''}\n${c.body}${c.body.endsWith('\n') ? '' : '\n'}`
}

export interface CaptureIo { out(s: string): void; err(s: string): void }

export async function runEvidenceCapture(argv: readonly string[], io: CaptureIo, doFetch: typeof fetch = fetch): Promise<number> {
  const outIdx = argv.indexOf('--out')
  const out = outIdx !== -1 ? argv[outIdx + 1] : undefined
  if (argv[0] !== 'capture' || !argv[1] || argv[1].startsWith('--')) { io.err('usage: agentop evidence capture <url> [--out <file>]'); return 2 }
  const target = argv[1]!
  let parsed: URL
  try { parsed = new URL(target) } catch { io.err(`not a URL: ${target}`); return 2 }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') { io.err('only http and https URLs can be captured'); return 2 }
  if (outIdx !== -1 && !out) { io.err('--out needs a file name'); return 2 }
  let res: Response
  try { res = await doFetch(target, { method: 'GET', signal: AbortSignal.timeout(15_000), headers: { accept: 'application/json, text/plain, */*' } }) } catch (e) {
    io.err(`request failed: ${e instanceof Error ? e.message : String(e)}`); return 1
  }
  const buf = new Uint8Array(await res.arrayBuffer())
  if (buf.length > API_CAPTURE_MAX_BYTES) { io.err(`the response is ${buf.length} bytes; a capture is limited to 1 MB`); return 1 }
  const body = new TextDecoder('utf-8', { fatal: false }).decode(buf)
  const text = formatCapture({ method: 'GET', url: target, status: res.status, statusText: res.statusText || '', headers: ((): Array<[string, string]> => { const h: Array<[string, string]> = []; res.headers.forEach((v, k) => h.push([k, v])); return h })(), body })
  // The same validator the server runs on attach: a capture that would be refused is refused HERE, with the rule, before any upload.
  const v = validateApiCapture(new TextEncoder().encode(text))
  if (!v.ok) { io.err(`this capture would not be accepted as evidence (${v.rule}): ${v.message}`); return 1 }
  if (out) { await writeFile(out, text); io.out(`captured ${target} → ${out} (${text.length} bytes)`) } else io.out(text)
  return 0
}
