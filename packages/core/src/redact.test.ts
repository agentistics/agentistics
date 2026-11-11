import { describe, expect, it, test } from 'bun:test'
import { redactSecrets, containsSecret, REDACTION } from './redact'

const R = '[REDACTED]'

describe('URI credentials', () => {
  test('redacts the password of a mongodb+srv URI but keeps user and host', () => {
    const out = redactSecrets('MONGO_URL=mongodb+srv://appuser:s3cr3tP4ssw0rd@cluster.mongodb.net/db')
    expect(out).toContain('mongodb+srv://appuser:')
    expect(out).toContain('@cluster.mongodb.net/db')
    expect(out).not.toContain('s3cr3tP4ssw0rd')
  })

  test.each([
    ['postgres', 'postgres://u:hunter2hunter2@db:5432/x'],
    ['mysql', 'mysql://root:tOpS3cretValue@127.0.0.1/app'],
    ['redis', 'redis://default:abcdefgh12345678@redis:6379'],
    ['amqp', 'amqp://guest:guestpassword1@rabbit:5672'],
    ['https basic', 'https://admin:MyPassw0rd123@internal.example.com/api'],
  ])('redacts a %s URI password', (_label, uri) => {
    const out = redactSecrets(uri)
    expect(out).toContain(R)
    expect(containsSecret(uri)).toBe(true)
  })

  test('leaves a URI with NO credentials untouched', () => {
    const clean = 'mongodb://localhost:27017/agentistics'
    expect(redactSecrets(clean)).toBe(clean)
    expect(containsSecret(clean)).toBe(false)
  })

  test('keeps the host so the prompt still says WHICH system it was about', () => {
    // The point of first_prompt is to label the session. Nuking the whole line would be safe
    // and useless; the host is the part that makes it readable.
    expect(redactSecrets('mongodb+srv://u1:pw12345678@elmd-geral-01.mongodb.net'))
      .toBe(`mongodb+srv://u1:${R}@elmd-geral-01.mongodb.net`)
  })
})

describe('provider tokens', () => {
  // Fixtures are ASSEMBLED AT RUNTIME on purpose. A literal token-shaped string in a committed
  // file trips GitHub's own push protection (it blocked this very branch on the Slack sample) —
  // and a test suite for a secret scrubber is the last place that should ship look-alike secrets.
  const j = (...parts: string[]) => parts.join('')
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  const a = 'abcdefghijklmnopqrstuvwxyz'
  const n = '0123456789'

  const CASES: [string, string][] = [
    ['GitHub PAT (classic)', j('ghp', '_', A, n, 'EXAMPLE')],
    ['GitHub fine-grained', j('github', '_pat_', '11', A, '_', a, n)],
    ['Anthropic', j('sk', '-ant-', 'api03-', A, n, a)],
    ['OpenAI', j('sk', '-proj-', A, n, a, A)],
    ['Slack', j('xox', 'b-', n, n, '-', A, a)],
    ['Google API key', j('AIza', 'Sy', A, a, n, 'ABCDEFGHI')],
    ['AWS access key id', j('AKIA', 'IOSFODNN7', 'EXAMPLE')],
  ]

  test.each(CASES)('redacts a %s', (_label, token) => {
    const out = redactSecrets(`here is the key ${token} use it`)
    expect(out).not.toContain(token)
    expect(out).toContain(R)
    expect(containsSecret(token)).toBe(true)
  })

  test('redacts a JWT', () => {
    const jwt = j('eyJ', 'hbGciOiJIUzI1NiJ9', '.', 'eyJ', 'zdWIiOiIxMjM0NTY3ODkwIn0', '.', A, n, a)
    expect(redactSecrets(jwt)).not.toContain(jwt)
  })

  test('redacts a private key block', () => {
    const body = j('MIIEowIBAAKCAQEA', A, n)
    const key = `-----BEGIN RSA PRIVATE KEY-----\n${body}\n-----END RSA PRIVATE KEY-----`
    const out = redactSecrets(key)
    expect(out).not.toContain(body)
    expect(out).toContain(R)
  })

  test('redacts a Bearer token', () => {
    const tok = j(a, n, A)
    const out = redactSecrets(`curl -H "Authorization: Bearer ${tok}" api`)
    expect(out).not.toContain(tok)
  })
})

describe('key=value assignments', () => {
  test.each([
    'PASSWORD=sup3rS3cretValue',
    'api_key: AbCdEf1234567890xyz',
    'SECRET="hunter2hunter2hunter"',
    "token = 'abcdef1234567890abcd'",
    'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  ])('redacts %s', (line) => {
    expect(redactSecrets(line)).toContain(R)
  })

  test('keeps the KEY NAME so the text still reads sensibly', () => {
    expect(redactSecrets('PASSWORD=sup3rS3cretValue')).toBe(`PASSWORD=${R}`)
  })

  test('does not swallow the character before the key name', () => {
    // Regression: the delimiter was consumed but not captured, so the preceding word was glued
    // onto the key — "run with PASSWORD=x" came out as "run withPASSWORD=[REDACTED]".
    expect(redactSecrets('run with PASSWORD=sup3rS3cretValue and go'))
      .toBe(`run with PASSWORD=${R} and go`)
  })
})

describe('false positives — these must survive untouched', () => {
  // A redactor that eats ordinary prose is worse than none: it destroys every session label
  // and people turn it off. These are all real phrasings from this project's own prompts.
  test.each([
    'input_tokens=123 output_tokens=456',
    'the token count was 1500',
    'tokens: 42',
    'reduce token usage by 90%',
    'my password is wrong, can you help debug the login?',
    'set the secret in GitHub Actions, not in code',
    'MONGO_URL=mongodb://localhost:27017',
    'api_key: <your-key-here>',
    'password: ****',
    'the API key is stored in 1Password',
    'fix(auth): rotate the token on logout',
    'PORT=47291',
    'timeout=30',
  ])('leaves %j alone', (text) => {
    expect(redactSecrets(text)).toBe(text)
    expect(containsSecret(text)).toBe(false)
  })
})

describe('behavior', () => {
  test('is a no-op on text with nothing to hide (returns the same string)', () => {
    const s = 'refactor the session parser to handle empty transcripts'
    expect(redactSecrets(s)).toBe(s)
  })

  test('tolerates empty and non-string-ish input', () => {
    expect(redactSecrets('')).toBe('')
    expect(redactSecrets(undefined as unknown as string)).toBe('')
    expect(redactSecrets(null as unknown as string)).toBe('')
  })

  test('redacts every occurrence, not just the first', () => {
    const t1 = ['ghp', '_', 'AAAAAAAAAAAAAAAAAAAAAAAAAAA1'].join('')
    const t2 = ['ghp', '_', 'BBBBBBBBBBBBBBBBBBBBBBBBBBB2'].join('')
    const out = redactSecrets(`a=${t1} b=${t2}`)
    expect(out).not.toContain(t1)
    expect(out).not.toContain(t2)
  })

  test('is idempotent — redacting twice changes nothing further', () => {
    const once = redactSecrets('MONGO_URL=mongodb+srv://u:pw12345678@h/db')
    expect(redactSecrets(once)).toBe(once)
  })

  test('containsSecret agrees with redactSecrets', () => {
    const dirty = 'mongodb+srv://u:pw12345678@h/db'
    expect(containsSecret(dirty)).toBe(true)
    expect(containsSecret(redactSecrets(dirty))).toBe(false)
  })
})
