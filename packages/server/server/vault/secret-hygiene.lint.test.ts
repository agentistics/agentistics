/**
 * SECRETS.4 §5.2 / §11 S4.1 lint over the vault and its consumers:
 *  - no `Buffer.allocUnsafe` (the shared pool keeps copies of whatever passed through it);
 *  - no module-level variable may hold a secret. Enforced as: EVERY module-level mutable binding in
 *    these files is listed below with the reason it holds no secret (or, for the one that does, why
 *    that is the rule and not a breach). A new one fails here until somebody writes its reason.
 */
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..', '..', '..')
const pkg = (p: string) => join(ROOT, 'packages', p)

function ts(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? (e.name === '__fixtures__' ? [] : ts(join(dir, e.name))) : /\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name) ? [join(dir, e.name)] : [])
}

const FILES = [
  ...ts(pkg('vault/src')),
  ...ts(pkg('server/server/vault')),
  pkg('server/server/envelope-keys.ts'),
  pkg('server/server/backup/github-store.ts'),
  pkg('server/server/backup/github-api.ts'),
  pkg('server/server/backup/github-cli.ts'),
  pkg('server/server/preferences.ts'),
]

/** file (relative to packages/) → binding → why it is not a secret held at module level. */
const ALLOWED: Record<string, Record<string, string>> = {
  'vault/src/recovery.ts': { INDEX: 'the public BIP-39 word → index table', BY_PREFIX: 'the public 4-letter prefix → index table' },
  'vault/src/protectors/memory.ts': { store: 'the TEST-ONLY in-memory protector; the host never offers it outside `bun test`' },
  'server/server/vault/central-env.ts': { SECRET_SET: 'the NAMES of the secret keys, not values' },
  'server/server/vault/engine-secrets.ts': { ENGINE_CODES: 'refusal codes', VAULT_ACTIONS: 'audit action names' },
  'server/server/vault/ops.ts': { _gate: 'the step-up gate function (S4.7)', GH_HEADERS_IN: 'header names', GH_METHODS: 'HTTP methods', _installed: 'a flag' },
  'server/server/vault/service.ts': {
    _vaultDir: 'a path', _role: 'holder|client', _lang: 'a language reader', _io: 'the IO adapter', _fs: 'the fs adapter',
    _scryptForTests: 'KDF cost parameters', _override: 'test protectors', _autoInit: 'test init policy',
    _opened: 'THE one place the human DEK lives — in the service process only (role holder), zeroed by lockVault; §5.2 makes this the rule, not a breach',
    _last: 'the last open state; its DEK (if any) is the same buffer as _opened, zeroed with it',
    _lastAttemptMs: 'a time', _inflight: 'a pending open', _lastChecked: 'detection reasons in words', _initFailure: 'a reason in words',
    _hardening: 'the §5.3 hardening report (states and reasons)', _hardeningRun: 'a pending hardening report',
    _lockedBy: 'why it is locked (a word)', _onState: 'the state-change listener (engine-api 1.6 onStateChange; carries a reason word, never a key)', _recoveryTodo: 'the re-enrolment steps owed (words)', _now: 'a clock',
    _autoClock: 'the idle clock (times)', _autoTimer: 'a timer', _onAutoLock: 'a notifier',
    _pending: 'THE DEK between a gesture and its code (§2.2): service-only, at most 120 s, zeroed on a wrong code, on expiry and by lockVault',
    _onInit: 'a reporter', _migrators: 'migrator objects (paths, no values)', _migratedThisOpen: 'a flag', _migrating: 'a pending report', _onUse: 'an activity hook',
  },
  'server/server/vault/gate.ts': {
    RECOVERY_ALLOWED: 'action names', _mem: 'the step-up counters (integrity, not secret — §2.3)', _now: 'a clock',
    _grantKey: 'the in-memory HMAC key that signs 5-minute read grants (§2.4: minted at start, never on disk); signs, decrypts nothing',
    _enrolSeed: 'a NEW TOTP seed while it is being enrolled (§2.5): ≤ 10 min, served once, zeroed on confirm/expiry/restart',
    _flow: 'a deadline (ms) + the session it belongs to, after which the wizard\'s one verified code stops standing for later steps; no key material', _enrolWrong: 'a wrong-code counter for one enrolment',
    _setup: 'the one-time SETUP code a page needs for a FIRST enrolment (review S2): 8 digits, 10 min, single use; authorises, decrypts nothing',
    _onSetupCode: 'the log sink the setup code is printed to',
    _recovery: 'NEW recovery entropy while its words are confirmed (§4.2): ≤ 10 min, zeroed on confirm/expiry',
  },
  'server/server/vault/sleep-watch.ts': { _proc: 'the gdbus monitor child process handle' },
  'server/server/vault/socket.ts': { _handler: 'the op dispatcher', _server: 'the listening socket' },
  'server/server/envelope-keys.ts': { _cachedPublic: 'the PUBLIC half only — the private key is opened per use' },
  'server/server/preferences.ts': {
    _tmpSeq: 'a counter', _testOnlyDisableLock: 'a test flag', _testOnlyForceLockVanished: 'a test flag',
    _testOnlyAcquireTimeoutMsOverride: 'a test number', _writeChain: 'a promise chain',
  },
}

const DECL = /^(?:export\s+)?(?:let|var)\s+([A-Za-z_$][\w$]*)|^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:new\s+(?:Map|Set|WeakMap|Array)\b|\[\s*\])/

describe('secret hygiene in the vault and its consumers', () => {
  test('no Buffer.allocUnsafe', () => {
    const offenders = FILES.filter(f => /allocUnsafe/.test(readFileSync(f, 'utf8'))).map(f => relative(ROOT, f))
    expect(offenders).toEqual([])
  })

  test('every module-level mutable binding has a stated reason (no module-level secret)', () => {
    const unexplained: string[] = []
    for (const f of FILES) {
      const rel = relative(join(ROOT, 'packages'), f)
      for (const line of readFileSync(f, 'utf8').split('\n')) {
        const m = DECL.exec(line)
        if (!m) continue
        const name = (m[1] ?? m[2])!
        if (!ALLOWED[rel]?.[name]) unexplained.push(`${rel}: ${name}`)
      }
    }
    expect(unexplained).toEqual([])
  })

  test('the private envelope key is no longer cached', () => {
    const t = readFileSync(pkg('server/server/envelope-keys.ts'), 'utf8')
    expect(/let\s+_cached\s*:\s*MachineKeypair/.test(t)).toBe(false)
  })
})
