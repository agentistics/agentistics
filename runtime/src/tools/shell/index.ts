/**
 * tools/shell — the persistent shell (B3.5, spec D-T2). `createShellTools` is the entry point; the
 * protocol and output modules are exported for the loop's and a host's tests.
 */
export * from './tools.ts'
export { OutputWindow, DEFAULT_MAX_OUTPUT_BYTES, MAX_OUTPUT_BYTES_CEILING, type TakenOutput } from './output.ts'
export { MarkerScanner, controlLine, shq } from './protocol.ts'
