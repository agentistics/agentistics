#!/usr/bin/env bun
/**
 * assert-official-engine.ts — the release's smoke test that an OFFICIAL binary carries its engine.
 *
 *   bun packages/server/scripts/assert-official-engine.ts <binary> --engine-dir <engine checkout>
 *
 * `release.yml` builds the official binaries with the private engine checked out at `engine.pin`'s
 * ref (spec §8/§9). A build in which the engine silently went missing still compiles — the slot
 * falls back to null — and would ship a community binary under an official name. This runs the
 * built binary's `--version` and FAILS unless its engine line says:
 *
 *   - an engine is present at all (`engine <version> (api <x.y.z>)`, not `engine: none …`);
 *   - its version is the CHECKED-OUT engine's own `package.json` version. That is what tells the
 *     pinned engine apart from the transitional in-tree one (`server/engine/in-tree.ts`), which
 *     reports the host's version and would otherwise pass a "some engine is present" check;
 *   - its contract version satisfies `engine.pin`'s `api` range.
 *
 * It ALSO fails when the engine's SOURCE is readable in the binary. Every official binary is public
 * (GitHub Releases, the desktop installer), so release.yml compiles with `--minify` and never with
 * `--sourcemap`; `findLeakedMarkers` greps the built bytes for strings an unminified bundle of the
 * engine carries and a minified one cannot — see `ENGINE_LEAK_MARKERS`.
 *
 * The decisions are the pure `checkEngineLine` / `findLeakedMarkers`; the rest is reading files and
 * running the binary.
 */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export interface EnginePin {
  ref: string
  api: string
}

export type EngineLineCheck = { ok: true; version: string; api: string } | { ok: false; reason: string }

const ENGINE_LINE = /^engine (\S+) \(api (\d+\.\d+\.\d+)\)$/

/** PURE. Judges `agentop --version`'s output against what the official build must carry. */
export function checkEngineLine(
  versionOutput: string,
  expected: { version: string; apiRange: string },
  satisfies: (version: string, range: string) => boolean,
): EngineLineCheck {
  const lines = versionOutput.split('\n').map(l => l.trim())
  const engineLine = lines.find(l => l.startsWith('engine'))
  if (!engineLine) return { ok: false, reason: 'the binary printed no engine line at all' }
  const m = ENGINE_LINE.exec(engineLine)
  if (!m) return { ok: false, reason: `the binary carries no engine: "${engineLine}"` }
  const [, version, api] = m as unknown as [string, string, string]
  if (version !== expected.version) {
    return {
      ok: false,
      reason: `the binary carries engine ${version}, not the pinned checkout's ${expected.version} (the in-tree engine, or another checkout, was bundled)`,
    }
  }
  if (!satisfies(api, expected.apiRange)) {
    return { ok: false, reason: `the engine speaks contract ${api}, outside engine.pin's range ${expected.apiRange}` }
  }
  return { ok: true, version, api }
}

/**
 * Strings that prove the engine's source sits readable in a binary. Each is present in an UNMINIFIED
 * official build and absent from a minified one (measured on engine cd7550cb: 1/6/1+ hits against 0).
 *
 *   - comment: Bun's bundler already drops ordinary comments, even without `--minify`; the comment it
 *     KEEPS is the per-module header `// <path to the module>`. `--minify` removes it.
 *   - internal name: `dropModelCaches`, a non-exported function of the engine's provider-web.ts.
 *     `--minify` renames it. (Today the public tree still carries a frozen twin of most engine code,
 *     this function included, so no engine identifier is unique to the engine yet; the marker proves
 *     the IDENTIFIERS are mangled, which is what keeps either copy unreadable.)
 *   - path: any module path under the engine's `engine/src/integrations/`. It also catches an
 *     embedded source map, whose `sources` list would name these paths.
 *
 * (Bun's own runtime carries `sourceMappingURL` / `"mappings":` strings — measured identical in a
 * hello-world binary — so those are not usable markers; the path marker is the source-map check.)
 */
export const ENGINE_LEAK_MARKERS: readonly { kind: 'comment' | 'internal-name' | 'path'; text: string }[] = [
  { kind: 'comment', text: '// ' },
  { kind: 'internal-name', text: 'dropModelCaches' },
  { kind: 'path', text: 'engine/src/integrations/' },
]
const COMMENT_TARGET = 'engine/src/cli-provider.ts'

/** PURE. Which leak markers occur in the binary's bytes. Empty = nothing readable was found. */
export function findLeakedMarkers(bytes: Uint8Array): string[] {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const found: string[] = []
  for (const m of ENGINE_LEAK_MARKERS) {
    if (m.kind === 'comment') {
      // A module-header comment line: `// ` … `engine/src/cli-provider.ts` on one line.
      let at = buf.indexOf(COMMENT_TARGET)
      while (at >= 0) {
        const lineStart = buf.lastIndexOf(0x0a, at) + 1
        if (buf.subarray(lineStart, at).toString('latin1').startsWith(m.text)) {
          found.push(`comment: "${buf.subarray(lineStart, at + COMMENT_TARGET.length).toString('latin1')}"`)
          break
        }
        at = buf.indexOf(COMMENT_TARGET, at + 1)
      }
    } else if (buf.includes(m.text)) {
      found.push(`${m.kind}: "${m.text}"`)
    }
  }
  return found
}

/** PURE. Parses and validates `engine.pin`. Throws with a sentence on a malformed pin. */
export function parseEnginePin(text: string): EnginePin {
  const raw = JSON.parse(text) as Partial<EnginePin>
  if (typeof raw.ref !== 'string' || !/^[0-9a-f]{40}$|^v\d+\.\d+\.\d+/.test(raw.ref)) {
    throw new Error('engine.pin: "ref" must be a full 40-character commit SHA or a v<x.y.z> tag')
  }
  if (typeof raw.api !== 'string' || raw.api.trim() === '') throw new Error('engine.pin: "api" must be a semver range')
  return { ref: raw.ref, api: raw.api }
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  const binary = argv[0]
  const dirAt = argv.indexOf('--engine-dir')
  const engineDir = dirAt >= 0 ? argv[dirAt + 1] : undefined
  if (!binary || !engineDir) {
    console.error('usage: assert-official-engine.ts <binary> --engine-dir <engine checkout>')
    process.exit(2)
  }
  const root = resolve(import.meta.dir, '..', '..', '..')
  const pin = parseEnginePin(readFileSync(join(root, 'engine.pin'), 'utf8'))
  const enginePkg = JSON.parse(readFileSync(join(resolve(engineDir), 'package.json'), 'utf8')) as { version?: string }
  if (typeof enginePkg.version !== 'string') {
    console.error(`::error::${engineDir}/package.json has no version`)
    process.exit(1)
  }
  const run = Bun.spawnSync([resolve(binary), '--version'], { stdout: 'pipe', stderr: 'pipe' })
  const out = run.stdout.toString()
  process.stdout.write(out)
  if (run.exitCode !== 0) {
    console.error(`::error::${binary} --version exited ${run.exitCode}: ${run.stderr.toString().trim()}`)
    process.exit(1)
  }
  const check = checkEngineLine(out, { version: enginePkg.version, apiRange: pin.api }, (v, r) => Bun.semver.satisfies(v, r))
  if (!check.ok) {
    console.error(`::error::not an official build — ${check.reason}. Refusing to release a community binary as official.`)
    process.exit(1)
  }
  const leaked = findLeakedMarkers(await Bun.file(resolve(binary)).bytes())
  if (leaked.length > 0) {
    console.error(`::error::the engine's source is readable in ${binary} (was it built without --minify, or with a source map?): ${leaked.join('; ')}`)
    process.exit(1)
  }
  console.log(`official engine present: engine ${check.version} (api ${check.api}), pinned at ${pin.ref}; no readable engine source`)
}
