import { describe, expect, test } from 'bun:test'
import { mkdir, readFile, writeFile, stat, mkdtemp } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AGENTISTICS_DATA_DIR } from '../config'
import {
  centralEnvTextWithSecrets, centralSecretsFile, isVaultedEnvFile, loadCentralEnv, migrateCentralEnvAt,
  plaintextSecretCount, splitCentralEnv, writeCentralEnv,
} from './central-env'

const SECRET = 'TEST-NOT-A-SECRET-session-' + Math.random().toString(36).slice(2)
const MONGO = 'mongodb+srv://TEST-NOT-A-SECRET-user:pw@cluster.example/agentistics'
const ENV = [
  '# agentistics Team Mode',
  'APP_PORT=48080',
  'BIND_IP=127.0.0.1',
  `MONGO_URL=${MONGO}`,
  'AGENTISTICS_TEAM_ORG=acme',
  `AGENTISTICS_TEAM_SESSION_SECRET=${SECRET}`,
  'AGENTISTICS_TEAM_INGEST_TOKEN=',
  'AGENTISTICS_EXPOSURE=lan',
  '',
].join('\n')

async function envFile(): Promise<string> {
  const dir = join(AGENTISTICS_DATA_DIR, 'central-' + Math.random().toString(36).slice(2))
  await mkdir(dir, { recursive: true })
  return join(dir, 'central.env')
}

describe('S6 — central.env split', () => {
  test('pure split: the four secret keys out, everything else (comments included) kept', () => {
    const { publicText, secrets } = splitCentralEnv(ENV)
    expect(secrets).toEqual({ MONGO_URL: MONGO, AGENTISTICS_TEAM_SESSION_SECRET: SECRET })
    expect(publicText).toContain('APP_PORT=48080')
    expect(publicText).toContain('# agentistics Team Mode')
    expect(publicText).not.toContain(SECRET)
    expect(publicText).not.toContain('MONGO_URL')
    expect(plaintextSecretCount(ENV)).toBe(2)
    expect(plaintextSecretCount(publicText)).toBe(0)
  })

  test('a write seals the secrets and leaves the public half, 0600; loading puts them back in memory', async () => {
    const f = await envFile()
    await writeCentralEnv(f, ENV)
    const pub = await readFile(f, 'utf8')
    expect(pub).not.toContain(SECRET)
    expect(pub).not.toContain('TEST-NOT-A-SECRET-user')
    expect((await stat(f)).mode & 0o777).toBe(0o600)
    expect(await readFile(centralSecretsFile(f), 'utf8')).not.toContain(SECRET)
    const { env, refusal } = await loadCentralEnv(f)
    expect(refusal).toBeNull()
    expect(env.AGENTISTICS_TEAM_SESSION_SECRET).toBe(SECRET)
    expect(env.MONGO_URL).toBe(MONGO)
    expect(env.APP_PORT).toBe('48080')
    // The doctor's in-memory view sees them as SET.
    expect(await centralEnvTextWithSecrets(f, pub)).toContain(`AGENTISTICS_TEAM_SESSION_SECRET=${SECRET}`)
  })

  test('an upgraded central: the plaintext file is migrated, idempotently', async () => {
    const f = await envFile()
    await writeFile(f, ENV, { mode: 0o600 })
    expect((await migrateCentralEnvAt(f)).migrated).toBe(2)
    expect(await readFile(f, 'utf8')).not.toContain(SECRET)
    expect((await migrateCentralEnvAt(f)).migrated).toBe(0)
    expect((await loadCentralEnv(f)).env.AGENTISTICS_TEAM_SESSION_SECRET).toBe(SECRET)
  })

  test('a re-run that leaves a secret blank keeps the sealed one', async () => {
    const f = await envFile()
    await writeCentralEnv(f, ENV)
    await writeCentralEnv(f, ENV.replace(`AGENTISTICS_TEAM_SESSION_SECRET=${SECRET}`, 'AGENTISTICS_TEAM_SESSION_SECRET='))
    expect((await loadCentralEnv(f)).env.AGENTISTICS_TEAM_SESSION_SECRET).toBe(SECRET)
  })

  test('an env file outside the data dir (a repo checkout for central.sh) is not split', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentistics-checkout-'))
    const f = join(dir, 'central.env')
    expect(isVaultedEnvFile(f)).toBe(false)
    await writeCentralEnv(f, ENV)
    expect(existsSync(centralSecretsFile(f))).toBe(false)
    expect((await stat(f)).mode & 0o777).toBe(0o600)
  })
})

describe('CI ingest writes no file (spec §5.5)', () => {
  test('ci-push.ts reads its token from the environment and has no file-writing call', async () => {
    const src = await readFile(join(import.meta.dir, '..', 'ci-push.ts'), 'utf8')
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(code).toContain('AGENTISTICS_CI_TOKEN')
    for (const w of ['writeFile', 'appendFile', 'Bun.write', 'createWriteStream', 'openSync', 'writeSync']) {
      expect(code.includes(w)).toBe(false)
    }
  })
})
