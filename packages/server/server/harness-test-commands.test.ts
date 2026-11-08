import { describe, expect, test } from 'bun:test'
import { countTestCommands } from './harness-activity'

describe('countTestCommands — a test runner invoked as a command', () => {
  test.each([
    'bun test',
    'bun test packages/server/server/foo.test.ts',
    'bun run test',
    'npm test',
    'npm run test:unit',
    'pnpm test',
    'yarn test',
    'bunx vitest run',
    'npx jest --ci',
    'pytest -q',
    'python -m pytest tests/',
    'go test ./...',
    'cargo test --workspace',
    'cargo nextest run',
    'NODE_OPTIONS=--max-old-space-size=3500 bun test',
    'rtk bun test',
    'agentop run --rm -- bun test packages/web',
    'NODE_OPTIONS=--max-old-space-size=3500 agentop run --rm -- bun test',
    'flock /tmp/agentistics-heavy.lock bun test',
    'cd packages/server && bun test',
  ])('counts %s', cmd => {
    expect(countTestCommands(cmd)).toBe(1)
  })

  test('a chain counts one per test segment', () => {
    expect(countTestCommands('bun test a && bun test b; echo done')).toBe(2)
    expect(countTestCommands('bunx tsc --noEmit && bun test')).toBe(1)
  })

  test.each([
    'echo "bun test"',
    '# bun test is next',
    'bun testify',
    'go test-helper',
    'git commit -m "bun test"',
    'ls tests/',
    'bunx tsc --noEmit',
    'bun install',
    'cat test.ts',
    '',
  ])('does not count %s', cmd => {
    expect(countTestCommands(cmd)).toBe(0)
  })
})
