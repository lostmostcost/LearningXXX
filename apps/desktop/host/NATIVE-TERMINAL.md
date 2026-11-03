# Native Claude Code · WBS-050 / CR-050

SPEC-002 v0.2.0, SPEC-003 v0.3.0, REQ-001/003/004/005/009. Owner explicitly approved normal Claude Code environments for general (previously independent) sessions and subscription-account use for this verification. Old chat migration/compatibility UI is out of scope by owner decision.

## What a person does

1. Start the Mac app and choose a course or general conversation.
2. Claude Code opens inside the right chat pane. Trust only a workspace you intend to use. The app does not answer its permission dialogs.
3. Type `/`: the installed CLI supplies the real command/skill list, arrows, autocomplete and dialogs. `/model`, `/compact`, `/resume`, `/clear`, `/permissions`, etc. go directly to Claude Code. Availability is still subject to the installed CLI/account/platform.
4. Change the app's session selector or recording tab: the terminal view detaches, the CLI stays alive. Return to reconnect. Stop with the square icon or the CLI's `/exit`.
5. PDF text: select → copy selection → paste into the intended CLI prompt. Files/PDFs: prepare → confirm → copy the prepared attachment path → paste. Nothing is automatically typed into a possible permission dialog or submitted.
6. Restart: SessionStart records the actual CLI UUID and history location after `/clear` or `/resume`; reconnect uses it only when history exists. A cleared empty session must not resurrect an older conversation. If the hook was disabled, the fallback is CLI `--continue` in that starting directory.

The process is on this Mac, with the official CLI's subscription login. No API fallback, token extraction or credential server. `probeCli` checks subscription auth before each new process. Starting permission mode is `default`, with no bypass flag. General sessions use global CLI settings, memory, plugins, skills and permissions; they are NOT isolated. Native file operations follow Claude Code, not the old host file UI's trash-only/rollback promises. The app never marks native file changes as host-reviewed.

## Local setup

Use the repository-pinned Node/pnpm and frozen installation. Dependency lifecycle scripts remain disabled (`node-pty: false`). On Mac, explicitly fetch Electron using the existing setup and run:

```sh
pnpm --filter @learningxxx/desktop-host run setup:pty
pnpm --filter @learningxxx/desktop-ui build
pnpm --filter @learningxxx/desktop-host start
```

`setup:pty` only grants executable mode to the official pinned node-pty package's Mac spawn-helper. Its bundled native addon was executed in Electron 44.9.0 on this Mac. A failed addon load is an explicit connection error, not a fallback to a shell or API.

## Ownership and lifecycle

Renderer requests session IDs, bytes, and bounded geometry only; it cannot select an executable, flags, cwd, environment or arbitrary shell. Host chooses the official CLI and UUID directory. Typed IPC checks input size and dimensions; replay is bounded to 512k UTF-16 units/process, eight running processes, sixteen retained entries. Backpressure waits for xterm output, input is serialized and long Unicode pastes preserve surrogate pairs. Raw output is not written to application logs.

Terminal process identity is separate from the old structured runner. Same-session opens coalesce; old `run.start` is rejected for native sessions. Archiving stops a session. Closing rejects input and reconnect until the actual exit; app shutdown waits then kills a remaining process group. App-generated attachment copies live under native-attachments, survive restart, require confirmation/account ownership, and never replace the original.

## Self-review evidence

- PTY transport: real TTY/ANSI, Unicode/bracketed paste, resize, EOF, reap and abandoned-child tests. Python harness is a spike only, not a product runtime dependency.
- Host/IPC: reviewed callers, session ownership, async open/archive/shutdown, buffer limits, symlink paths, subscription preflight, native/structured separation and hook replay. Fixed early lifecycle races, phantom reconnect after close and missing gap indication for one oversized output chunk.
- Resume: found that `/clear` can create a UUID with no persisted history; record the CLI-reported history location and start fresh when absent. Never blindly `--continue` to an older conversation in that case.
- Attachment: found transient `forRun` cleanup deleted prepared native references on restart; added persistent `forNative` with confirmation, account/session validation, read-only copy and hash verification; regression test covers restart.
- Frontend: reviewed hidden-tab preservation, per-session selection, automatic-input risk, stale course/session create completion, duplicate clicks and large emoji paste. Removed the compatibility/history view at owner request. Fixed duplicate creation with a synchronous lock and stopped hidden structured chat from consuming selection requests (then removed that view).
- Build: corrected an accidentally overwritten stylesheet immediately after the production CSS check failed; reran full checks. Native install scripts remain disabled; explicit Mac helper permission setup fixed `posix_spawnp failed`.

## Actual validation · 2026-11-03

- `docker compose run --rm tools`: PASS; frozen lockfile, tooling, all workspace type/tests/build checks. UI 96 tests, host 152 pass + one pre-existing skipped integration test.
- `python3 -m unittest discover -s tests/tooling -p test_interactive_pty.py -v`: six PASS, no Claude calls.
- Mac official CLI initially reported 2.1.316 and updated itself to 2.1.317 at interactive startup. Normal native validation used 2.1.317; old independent-version evidence is not inherited.
- Official subscription (Claude Pro), Haiku synthetic canary: response PASS; `/model` menu PASS; native `/` list PASS; `/compact` completed; post-compaction recall PASS; exit and `--resume` restored compacted conversation and recalled canary PASS. No private course data was used in model verification.
- Product NativeTerminalService + actual node-pty: launch, native model dialog, SessionStart mapping and no prompt retention PASS (`ui050-native-live-result.json`, local /tmp only).
- Actual Electron 44.9.0 runtime: native PTY child output `NATIVE_ELECTRON_PTY_OK` PASS.
- Actual Mac app: opened general session, trusted its new app workspace, native slash/skill menu displayed. User began interacting with the open app; further UI testing moved to a background synthetic fixture to avoid interference.

These are AI-performed checks, not fabricated human QA. Every vendor command was not individually executed: destructive settings, logout, purchases and remote execution were not exercised. The architecture forwards them to the actual CLI rather than emulating a fixed allowlist. Native multi-session process retention is covered by host tests; vendor commands may intentionally close or redirect a session. Current in-use app is not forcibly restarted by the agent.
