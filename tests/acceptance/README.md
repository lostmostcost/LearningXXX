# WBS-019 — A integration evidence

REQ-001…006, QA-001 v0.2.0; CR-001 local manual collection; baseline main `d78f379` (WBS-017), containing WBS-009 #17, WBS-012 #19, WBS-016 #20 and WBS-018 #22. Allowed scope: `tests/acceptance/` only. Product defects/missing workflows require separate module tasks and claims.

## Run

On the pinned Node/pnpm toolchain after `pnpm install --frozen-lockfile`:

```sh
sh tests/acceptance/run.sh
sh tests/acceptance/run.sh --require-ready
```

Docker (no host Node, dependencies or credentials required):

```sh
docker compose run --rm tools sh -c 'mkdir -p /tmp/ws && tar -C /workspace --exclude=./.git --exclude="*/node_modules" -cf - . | tar -C /tmp/ws -xf - && cd /tmp/ws && pnpm install --frozen-lockfile --store-dir /tmp/pnpm-store --reporter=silent && sh tests/acceptance/run.sh'
```

Add `--require-ready` to the final script invocation for the strict A gate. The script type-checks this suite, uses TAP to preserve test/TODO counts, and returns nonzero for any test/type failure. Strict mode also refuses TODOs and skipped requirements. The existing root `docker compose run --rm tools` / GitHub project-checks do **not** discover this separate suite; run this command explicitly until a shared tooling task wires it into CI. A successful development-mode run is not A acceptance completion.

## What executes

Actual collector + directory store → actual LibraryService/IPC router → viewer data model and real pdf.js legacy text extraction → composer → SessionService → actual CLI adapter/parser → disposable synthetic subprocess → chat reducer and persisted session/run/history stores.

`harness.ts` creates a temporary synthetic home, absolute synthetic executable, local library/workspaces and test Trash, then removes only that fixture directory. Fetch is injected and never reaches the network. The subprocess is built from the existing adapter test fixture and never invokes installed Claude Code. The environment is explicitly constructed; no real login, keys, student files or environment credentials are inherited. All PDF data is synthetic. Test Trash uses filesystem rename; it does not exercise macOS Trash or native dialogs.

| Requirement / path | Evidence |
| --- | --- |
| REQ-002/003 collection → PDF | User-triggered collection, download credential stripping on cross-origin redirect, local original hash verification, viewer target, real PDF open/text extraction |
| REQ-006 selection → chat | Explicit excerpt/intent freezes into IPC, stdin and rendered answer; unselected page/course canaries absent from payload |
| REQ-004/005 session resume | Persist/reopen, same CLI session resumes, another independent session uses a different workspace and a fresh CLI session |
| REQ-002 offline/expiry/account | Cached PDF survives failed collection; login requested on 401; switching LMS user rejects former account asset |
| REQ-001 credentials/failures | API environment refused without subprocess; CLI auth expiry, weekly limit, wrong session and reported outside access produce terminal host state, no automatic retry/leaked canary |
| Duplicate/cancel | Collection lock, requestId dedup, partial output preserved on cancellation and no resend on reopen |
| WBS-017 regression integration | Actual subprocess writes → host snapshot/change list → test Trash restore; explicit delete refusal preserves file |
| Attachment/capture boundary | Unknown/unprepared IDs rejected rather than silently discarded; **delivery is still unimplemented** |

The fake CLI only reports simulated tool events; these tests do not prove the real CLI's OS isolation or translation quality. `openPdf` exercises parsing/text extraction, not canvas/TextLayer alignment or source-link clicks. Those UI checks and actual Mac/native permission behavior belong to the real app flow, with the existing WBS-018 synthetic UI evidence kept separate.

## Current result and blocking gaps

Development suite: **11 PASS, 0 FAIL, 3 TODO**. Strict `--require-ready`: **BLOCKED, exit 1**. Not a completed A gate or developer self-QA.

| ID | Missing existing MVP workflow | Evidence / follow-up |
| --- | --- | --- |
| A-001 | Course/local-file attachment preparation, explicit confirmation and verified run-specific delivery | ChatPanel attachment control disabled; SessionService rejects attachmentIds. [Backlog](https://app.notion.com/p/40bbd7ec20cd814b8c4dec1865941e20) |
| A-002 | Capture selection/cancel/preview/confirmation and run-specific delivery | Capture control disabled; host rejects captureIds. [Backlog](https://app.notion.com/p/40bbd7ec20cd81a496dbd36ca117758f) |
| A-003 | File grant/change list/restore/trash controls in renderer | files.* host API exists but no UI invocation. [Backlog](https://app.notion.com/p/40bbd7ec20cd819e83a7e8546333465a) |

Replace each TODO with assertions that exercise the implemented workflow using prepared/registered IDs (not fabricated IDs). Add the UI/native confirmation evidence, rerun strict mode, then complete WBS-019 and start WBS-020 developer functional self-test. WBS-019 remains Blocked while these required paths are missing. No extra peer/human QA card is introduced for this work.

Unrun here: real LMS login/expiry, subscription CLI calls, actual Mac screenshots/capture permissions and Trash, native app rendering, real translation quality, and developer hands-on A self-test. The logged-in Claude account was not used.
