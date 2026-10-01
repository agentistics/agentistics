/**
 * preload.ts — every `bun test` in this repository runs under a TEST host (`bunfig.toml`).
 *
 * The engine reads nothing of the machine on its own (`engine/src/host.ts`), so a test that reaches
 * a default — a harness root, the key store, the content store — needs a host installed. This one
 * roots every path in a fresh temp directory (a test can never read the developer's real
 * `~/.claude`), and takes the two request helpers from the PUBLIC host itself, because the provider
 * route's tests assert their exact behaviour (an oversized body refused before it is parsed, a
 * sanitised 500) and a re-implementation here would prove the copy rather than the contract.
 *
 * The reuse surface is the public host's OWN (`buildReuseSurface`, the value `hostServices()` hands a
 * real engine), installed before the host so `testHost` carries it and an integration test that
 * never calls `createEngine` still reads the public parsers.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readJsonLimited } from '@agentistics/server/server/limits'
import { safeError } from '@agentistics/server/server/errors'
import { buildReuseSurface } from '@agentistics/server/server/engine/reuse-surface'
import { installHost, testHost } from '../src/host'
import { installReaders } from '../src/reuse'

installReaders(await buildReuseSurface())

installHost(testHost(mkdtempSync(join(tmpdir(), 'agentistics-engine-test-')), { readJsonLimited, safeError }))
