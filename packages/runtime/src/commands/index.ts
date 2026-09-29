/**
 * commands/ — the ONE command registry (B8.5, spec §5.1): built-ins as runtime data with host
 * handlers, plus the catalogue's custom markdown commands. Every surface reads it.
 */
export * from './builtins.ts'
export * from './registry.ts'
