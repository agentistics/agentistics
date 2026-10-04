# TUI code-entry fix

Plain `agentop` no longer acquires the native code host or exposes the code tab/native palette
commands. The code tab is mounted only by the explicit `agentop code` path, and the existing
`nativeExperimentalOn()` gate refuses that command with the Settings → Experimental sentence and
CLI alternative when the flag is off. An environment-restored `code` tab is also ignored on the
plain path.

Checks:

- `native-gate.test.ts`
- `code-launch.test.ts`
- `code-entry.test.ts` — ordinary cockpit excludes code; explicit entry includes it
- `nav.test.ts`
- `code.test.ts`
- isolated PTY: `agentop code --lang pt`, fresh HOME, flag off → sentence and exit 2

The full Ink/React control-center test could not run in the clean clone because
`ink-testing-library` is not installed in the available dependency cache.
