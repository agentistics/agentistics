/**
 * policy/ — the B3 permission policy (D-T3): the shell parser, the rule layers, the deny floor and
 * `createPolicy`. Re-exported here so the package index can add ONE line when this is integrated.
 */
export * from './shell-parse.ts'
export * from './rules.ts'
export * from './floor.ts'
export * from './policy.ts'
