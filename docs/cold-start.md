# Cold data builds and HTTP responsiveness

The boot warm-up in `packages/server/server/index.ts` calls `buildApiResponse` after requesting
its startup snapshot/quick payload. A first `/api/data` also calls `buildApiResponse` (or
`buildApiResponseForClient` when the client accepts a partial response). `startFirstBuild` stores
one promise while the status is `computing`; concurrent full requests await that same build.
Partial-capable requests keep the existing snapshot/quick-payload behavior. Health and static
assets do not await the build, but still need the same JavaScript event loop to run.

The full build reads stats, session metas and health, then calls `scanProjects` →
`scanProjectDir` → `cachedParseSession`/`cachedEnrich` → `claudeTranscriptState`. Filesystem reads
are already asynchronous. CPU parsing after those reads is the remaining synchronous work:
`foldClaudeParse` parses each JSON line and folds its metrics. Previously the cold reader yielded
only between 1 MB text slices; a small file never yielded explicitly. Agent enrichment then calls
`enrichFromSubagentTranscripts` → `summaryFor` → `summarizeSubagentTranscript`, which previously
split and parsed the entire subagent file without yielding. The later Codex adapter similarly
called `parseCodexRollout` over an entire file, including a materialized array of all its lines.
The consolidate store already uses asynchronous fs and a read limiter; it is not a synchronous
transcript directory walk.

`cooperative-work.ts` now drains those three CPU folds with `setImmediate` scheduling turns and an
8 ms cooperative budget checked between records. Small files get an initial scheduling turn too,
so a sequence of ready fs promises cannot monopolize microtasks. Synchronous callers and live
readers use the same generator body. No metric formulas, cache variants, HTTP payload contracts,
or build-cache guards change. Codex and subagent readers iterate lines without splitting a second
array for the entire transcript.

This is cooperative scheduling, not a hard latency limit. One huge JSON record, UTF-8 decoding of
a whole file, final reductions, cache SQLite/JSON operations, serialization, workflow extraction
and the other harness parsers still execute synchronously. Whole-file buffers also remain. A
contended machine or those remaining operations can exceed the scheduling budget. This change
must be checked against real-size cold and warm history before asserting a health latency bound;
it does not promise a shorter total build time.

`cold-start.test.ts` checks synchronous/yielding fixture equality for Claude, subagents and Codex.
Its isolated subprocess wraps the real data builder in a minimal HTTP server, stubs a CPU-heavy
adapter build, checks health before releasing it, and checks eight data requests receive the same
fixture payload after one build. It deliberately avoids the unrelated daemons started by
`index.ts`. These tests complement, rather than replace, full-server QA with real history.
