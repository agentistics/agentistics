#!/usr/bin/env bun
/**
 * link-public.ts — makes this checkout resolvable on its own.
 *
 * The engine compiles against the PUBLIC repository's `@agentistics/core` and
 * `@agentistics/engine-api` (the only public packages it may import in production), plus the public
 * server tree, which only the TESTS and the PROOFS read (the differentials compare against the public
 * legacy readers, and `test/preload.ts` installs the host's own reuse surface). Those are not published,
 * so this links them from a public checkout into `node_modules/@agentistics/`, and links this
 * repository's own two packages beside them.
 *
 * The public checkout is `AGENTISTICS_PUBLIC_DIR`, else `../agentistics`. A checkout that is not
 * there is REFUSED in a sentence: a half-linked tree typechecks against nothing and every error it
 * then prints is about the wrong thing.
 *
 * When this repository is overlaid onto a public checkout instead (`packages/engine` +
 * `packages/runtime`, the official build), the public workspace resolves all of it and this script
 * is not needed.
 */
import { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..')
const PUBLIC = resolve(ROOT, process.env.AGENTISTICS_PUBLIC_DIR ?? '../agentistics')

if (!existsSync(join(PUBLIC, 'packages', 'engine-api', 'package.json'))) {
  console.error(`link-public: no public checkout with packages/engine-api at ${PUBLIC} — set AGENTISTICS_PUBLIC_DIR`)
  process.exit(1)
}

const links: Record<string, string> = {
  core: join(PUBLIC, 'packages', 'core'),
  'engine-api': join(PUBLIC, 'packages', 'engine-api'),
  server: join(PUBLIC, 'packages', 'server'),
  runtime: join(ROOT, 'runtime'),
  engine: join(ROOT, 'engine'),
}

const scope = join(ROOT, 'node_modules', '@agentistics')
mkdirSync(scope, { recursive: true })
for (const [name, target] of Object.entries(links)) {
  const at = join(scope, name)
  try { if (lstatSync(at)) rmSync(at, { recursive: true, force: true }) } catch { /* absent */ }
  symlinkSync(target, at, 'dir')
}
console.log(`link-public: @agentistics/{${Object.keys(links).join(',')}} → ${PUBLIC} + this checkout`)
