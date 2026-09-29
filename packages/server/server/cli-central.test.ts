import { describe, expect, test } from 'bun:test'
import { buildCentralEnv, STANDALONE_COMPOSE,
  STANDALONE_LOCALDB_COMPOSE, isCentralAction, CENTRAL_ACTIONS, isBundledMongo, looksLikeMongoUri, BUNDLED_MONGO_URL, planCentralStart } from './cli-central'

/** Parse the `KEY=value` lines of a central.env blob into a map (ignores comments/blanks). */
function parseEnv(blob: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of blob.split('\n')) {
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    out[line.slice(0, eq)] = line.slice(eq + 1)
  }
  return out
}

describe('buildCentralEnv', () => {
  test('applies defaults and auto-generates secrets when omitted', () => {
    const env = parseEnv(buildCentralEnv())
    expect(env.APP_PORT).toBe('48080')
    // LOOPBACK, not 0.0.0.0. The compose files have defaulted to 127.0.0.1 for exactly the reason
    // stated there — a fresh install must not land on the network by accident — while this
    // generator wrote 0.0.0.0 over the top of them, which made the documented default a fiction on
    // every central the wizard created. Widening it is now an answer the operator gives.
    expect(env.BIND_IP).toBe('127.0.0.1')
    expect(env.AGENTISTICS_TEAM_ORG).toBe('default')
    expect(env.AGENTISTICS_TEAM_CENTRAL).toBe('1')
    // hex(32) → 64 hex chars.
    expect(env.AGENTISTICS_TEAM_SESSION_SECRET).toMatch(/^[0-9a-f]{64}$/)
    // No shared dashboard password: a central authenticates ACCOUNTS, and the owner account is
    // created in the browser with the one-time setup token. Writing one here is what made the
    // setup wizard ask for a "team password" that no longer gates anything.
    expect(env.AGENTISTICS_TEAM_PASSWORD).toBeUndefined()
    // Ingest token defaults to empty (teams use per-member minted tokens).
    expect(env.AGENTISTICS_TEAM_INGEST_TOKEN).toBe('')
    expect(env.AGENTISTICS_CENTRAL_USER).toBe('')
    // Mongo is internal — the env points the app at the compose service, not localhost.
    expect(env.MONGO_URL).toContain('mongo:27017')
  })

  test('honors provided values verbatim (no random override)', () => {
    const env = parseEnv(buildCentralEnv({
      port: '9000',
      org: 'acme',
      sessionSecret: 'my-secret',
      ingestToken: 'shared-tok',
      bind: '100.64.0.5',
    }))
    expect(env.APP_PORT).toBe('9000')
    expect(env.BIND_IP).toBe('100.64.0.5')
    expect(env.AGENTISTICS_TEAM_ORG).toBe('acme')
    expect(env.AGENTISTICS_TEAM_SESSION_SECRET).toBe('my-secret')
    expect(env.AGENTISTICS_TEAM_INGEST_TOKEN).toBe('shared-tok')
  })

  test('two calls generate distinct secrets', () => {
    const a = parseEnv(buildCentralEnv())
    const b = parseEnv(buildCentralEnv())
    expect(a.AGENTISTICS_TEAM_SESSION_SECRET).not.toBe(b.AGENTISTICS_TEAM_SESSION_SECRET)
  })
})

describe('STANDALONE_COMPOSE', () => {
  test('pulls the published image and never builds from source', () => {
    // The whole point of the standalone path: pull, not build (no repo present).
    expect(STANDALONE_COMPOSE).toContain('ghcr.io/agentistics/agentistics')
    expect(STANDALONE_COMPOSE).toContain('${AGENTISTICS_IMAGE')
    expect(STANDALONE_COMPOSE).not.toContain('build:')
  })

  test('wires every central.env value the app + ports depend on', () => {
    for (const key of [
      'APP_PORT', 'BIND_IP', 'MONGO_URL', 'AGENTISTICS_TEAM_ORG',
      'AGENTISTICS_TEAM_PASSWORD', 'AGENTISTICS_TEAM_SESSION_SECRET', 'AGENTISTICS_TEAM_INGEST_TOKEN',
    ]) {
      expect(STANDALONE_COMPOSE).toContain(`\${${key}`)
    }
    // Central mode + static serving must be forced on regardless of env.
    expect(STANDALONE_COMPOSE).toContain('AGENTISTICS_TEAM_CENTRAL: "1"')
    expect(STANDALONE_COMPOSE).toContain('SERVE_STATIC: "1"')
  })

  // The bundled database moved to its OWN overlay, merged only when MONGO_URL targets the internal
  // service — the same rule central.sh applies. It used to be welded into the single generated
  // file, so a standalone central pointed at Atlas still started a local Mongo container beside it
  // and waited on its healthcheck.
  test('the bundled Mongo is an overlay, not part of the app compose', () => {
    expect(STANDALONE_LOCALDB_COMPOSE).toContain('mongo:7')
    expect(STANDALONE_LOCALDB_COMPOSE).toContain('mongo_data:')
    expect(STANDALONE_COMPOSE).not.toContain('mongo:7')
  })
})

describe('isCentralAction', () => {
  test('accepts exactly the documented actions', () => {
    for (const a of CENTRAL_ACTIONS) expect(isCentralAction(a)).toBe(true)
    expect(isCentralAction('bogus')).toBe(false)
    expect(isCentralAction('')).toBe(false)
  })
})

describe('external database (Atlas) support', () => {
  function parseEnv(blob: string): Record<string, string> {
    const out: Record<string, string> = {}
    for (const line of blob.split('\n')) {
      if (!line || line.startsWith('#')) continue
      const eq = line.indexOf('=')
      if (eq !== -1) out[line.slice(0, eq)] = line.slice(eq + 1)
    }
    return out
  }

  test('buildCentralEnv writes an external MONGO_URL when given, else the bundled one', () => {
    expect(parseEnv(buildCentralEnv()).MONGO_URL).toBe(BUNDLED_MONGO_URL)
    const atlas = 'mongodb+srv://u:p@cluster.abc.mongodb.net/?retryWrites=true'
    expect(parseEnv(buildCentralEnv({ mongoUrl: atlas })).MONGO_URL).toBe(atlas)
  })

  test('isBundledMongo distinguishes the Docker service from external URIs', () => {
    expect(isBundledMongo(BUNDLED_MONGO_URL)).toBe(true)
    expect(isBundledMongo('mongodb://mongo:27017/?replicaSet=rs0')).toBe(true)
    expect(isBundledMongo('mongodb+srv://u:p@cluster.abc.mongodb.net/')).toBe(false)
    expect(isBundledMongo('mongodb://my-vps.example.com:27017/db')).toBe(false)
    expect(isBundledMongo('')).toBe(false)
  })

  test('looksLikeMongoUri validates connection strings', () => {
    expect(looksLikeMongoUri('mongodb://host:27017/db')).toBe(true)
    expect(looksLikeMongoUri('mongodb+srv://u:p@c.mongodb.net/')).toBe(true)
    expect(looksLikeMongoUri('  mongodb+srv://x  ')).toBe(true)
    expect(looksLikeMongoUri('http://nope')).toBe(false)
    expect(looksLikeMongoUri('mongodb://')).toBe(false)
    expect(looksLikeMongoUri('')).toBe(false)
  })
})

/**
 * Which shape a `central up` takes — asked BEFORE it runs, because the answer decides who gets the
 * terminal. The control center streams a build into a pane, and it may only do that for a run with
 * no question in it and an end.
 */
describe('planCentralStart', () => {
  test('no env file is a QUESTION, on either path — it is generated interactively on first run', () => {
    expect(planCentralStart({ script: true, envFile: false, mongoUrl: '' })).toBe('init')
    expect(planCentralStart({ script: false, envFile: false, mongoUrl: '' })).toBe('init')
  })

  test('central.sh drives compose whatever the database is, so it can be watched', () => {
    expect(planCentralStart({ script: true, envFile: true, mongoUrl: BUNDLED_MONGO_URL })).toBe('script')
    // An external cluster only means central.sh leaves the bundled Mongo out of the compose.
    expect(planCentralStart({ script: true, envFile: true, mongoUrl: 'mongodb+srv://a@b.net/' })).toBe('script')
  })

  test('without a checkout, the bundled database is the published image — also just compose', () => {
    expect(planCentralStart({ script: false, envFile: true, mongoUrl: BUNDLED_MONGO_URL })).toBe('image')
  })

  // The one that must NOT be streamed: with an external database the standalone path runs the binary
  // itself, in the foreground, forever. A pane would show a banner and then wait for an exit that
  // never comes, so this keeps the terminal handover.
  test('without a checkout, an external database runs NATIVELY and needs the terminal', () => {
    expect(planCentralStart({ script: false, envFile: true, mongoUrl: 'mongodb+srv://user:pw@c.mongodb.net/' })).toBe('native')
  })
})
