/**
 * sandbox/ — D-T5's v1: a capability probe, resource limits (prlimit / ulimit) and Docker as the
 * opt-in container, behind the frozen `SandboxLauncher` interface of `../tools/contract.ts`. The
 * four states (no sandbox · filesystem only · full container · requested but unavailable) are said
 * in words by `sentences.ts`; `filesystem-only` is reserved for Landlock / bubblewrap, which no v1
 * path produces.
 */
export * from './probe'
export {
  type ResourceLimits, type LimitName, LIMIT_NAMES, invalidLimit, hasLimits, prlimitArgv, ulimitValue,
  ulimitUnsupported, ulimitArgv, type DockerSettings, HOST_ONLY_ENV, isHostOnlyEnv, ENV_NAME, dockerRunArgv,
  // LEXICAL containment (resolves `..`, follows no symlink) — renamed on the way out so it is never
  // mistaken for `tools/paths.ts` `isInside`, which compares already symlink-resolved paths.
  isInside as isLexicallyInside,
} from './wrap-argv'
export * from './sentences'
export * from './launcher'
