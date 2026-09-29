import { describe, expect, test } from 'bun:test';
import { resolveAsset, isMonorepoCheckout } from './platform.js';

describe('resolveAsset', () => {
  test('linux x64 resolves the version-tagged GitHub release asset URL', () => {
    const result = resolveAsset('linux', 'x64', '1.22.1');
    expect(result).toEqual({
      ok: true,
      url: 'https://github.com/agentistics/agentistics/releases/download/v1.22.1/agentop',
      urls: [
        'https://github.com/agentistics/agentistics/releases/download/v1.22.1/agentop',
        'https://github.com/blpsoares/agentistics/releases/download/v1.22.1/agentop',
      ],
    });
  });

  test('darwin is refused with a message naming the detected OS', () => {
    const result = resolveAsset('darwin', 'x64', '1.22.1');
    expect(result.ok).toBe(false);
    expect(result.message).toBe(
      'Error: only Linux binaries are published at the moment (detected: Darwin).'
    );
  });

  test('win32 is refused with a message naming the detected OS', () => {
    const result = resolveAsset('win32', 'x64', '1.22.1');
    expect(result.ok).toBe(false);
    expect(result.message).toContain('detected: Windows');
  });

  test('linux arm64 is refused with a message naming the detected arch', () => {
    const result = resolveAsset('linux', 'arm64', '1.22.1');
    expect(result.ok).toBe(false);
    expect(result.message).toBe(
      'Error: only x86_64 binaries are published at the moment (detected: arm64).'
    );
  });

  test('an unmapped platform/arch falls back to the raw node value in the message', () => {
    const result = resolveAsset('freebsd', 'mips', '1.22.1');
    expect(result.ok).toBe(false);
    expect(result.message).toContain('detected: freebsd');
  });
});

describe('isMonorepoCheckout', () => {
  test('true when the ancestor package.json is the agentistics monorepo root', () => {
    expect(isMonorepoCheckout({ name: 'agentistics' })).toBe(true);
  });

  test('false for an unrelated consumer project (npm install as a dependency)', () => {
    expect(isMonorepoCheckout({ name: 'some-other-app' })).toBe(false);
  });

  test('false when there is no ancestor package.json at all', () => {
    expect(isMonorepoCheckout(null)).toBe(false);
  });
});
