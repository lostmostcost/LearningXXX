# Local transcription worker

`TranscriptionQueue` runs one original at a time on this Mac with the engine
provided by the host. It persists `jobs.json` and engine transcripts under
`transcripts/<id>.json` in its private `root`. It reads originals through
`pathOf` and never deletes or changes them. No summary is started automatically.

## Queue boundaries (WBS-046 / SPEC-004 / REQ-007, REQ-008)

- A pending job records the engine name, version and parameter hash that created
  it. Restarting with a different engine does not execute that job under its old
  label: it becomes `failed / ENGINE_UNAVAILABLE`. Existing completed transcripts
  remain unchanged. Enqueue the original under the current engine to create a
  separate version, or restore the old engine and retry its job. Repeated enqueue
  under the same configuration still reuses the same idempotency key.
- Cancel signals the active engine and waits for it to settle. Even an engine
  that returns a result after abort cannot commit a transcript. Shutdown also
  rejects late results, leaving the running job for the existing lease recovery
  flow. An engine that ignores abort forever can still delay `cancel`/`stop`;
  process termination/timeout is the engine adapter's responsibility.
- The queue checks abort after course-term lookup and before committing output.
  Progress callbacks from settled/cancelled runs and non-finite/out-of-range
  values are ignored. Engines/parameters changed mid-run cannot produce an
  output labeled with the previous settings.
- `onChange` is an observation callback: exceptions and mutations of the supplied
  copy cannot change durable job state. A worker is reserved before callbacks
  run, so a callback that enqueues another original cannot launch two workers.
  The host should still keep callbacks short and handle its own UI failures.

## Execution and recovery

1. Host supplies a per-account private queue root, configured engine and trusted
   original path resolver; it enqueues each confirmed original and calls `start()`.
2. Status/progress notifications update UI. Cancellation is explicit; a shutdown
   calls `stop()`. Neither path removes the original.
3. On restart, load the same root and enqueue known originals. Expired running
   leases are recovered; changed engine configurations get a new job/version.
4. `transcript(job.outputTranscriptId)` reads a successful version. Enqueue/retry
   must not be confused with a request to summarize or correct that transcript.

Run `docker compose run --rm tools` from the repository root for frozen-lockfile,
type, synthetic queue/worker and existing workspace checks. The WBS-046 regression
tests use a fake engine that deliberately ignores abort, an engine switch,
observer failure/reentry, and saved transcript comparison. They do not run MLX,
access private lecture content, perform native Mac QA or complete WBS-027/028.
