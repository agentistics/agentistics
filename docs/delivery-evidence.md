# Delivery evidence

Evidence enters through `POST /api/tasks/:ref/evidence`, `agentistics_task_evidence`,
or `agentop task evidence add`. Uploads are capped at 8 MB. The server derives the
hash, revision, timestamp and checkout binding; callers supply the artifact.

The persisted reuse index permits a hash on one piece and one revision. Concurrent
identical attaches return the existing evidence id and discard redundant uploads.
If the revision changes while uploading, the attach refuses and removes the upload;
the caller retries against the current revision. Persistence failures also roll back
the new TaskFile. A cleanup failure is reported explicitly rather than hidden.

An evidence item or its backing TaskFile cannot be deleted while a checkpoint or
pending authorization intent names it. Task deletion follows the same rule for all
its files. Deletes refuse with HTTP 409 `evidence_in_use` when the delivery index or
the relevant authorization book cannot be read. Unknown preserved delivery records
also refuse deletion because this binary cannot establish their references.

Deletion checks and mutations follow the global lock order: tasks, deliveries,
guards. Evidence detachment holds deliveries and guards through persistence;
TaskFile and aggregate task deletion hold all three through index and byte removal.
Task-web injects this composition through the task store's optional deletion port;
the store itself has no dependency on delivery guards. Public deletion callers must
use this composition; the default low-level port preserves existing store behavior.

The MCP proof audit checks each write payload and pins the eleven inherited S0a
exceptions to a fixed baseline that can only shrink. It checks transport data flow;
rejecting a missing or invalid session proof belongs to S0a. Until that dependency
lands, a call to the proof builder does not establish that a usable proof exists.
