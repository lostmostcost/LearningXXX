# LearningXXX agent contract

## Read before work
1. Read README.md, docs/specs/PRD-001.md, relevant SPEC, OPS-001 and QA-001.
2. Read current Notion WBS and approved CRs. Snapshot statuses are not current authorization.
3. Confirm task is Ready, dependencies Done, and you hold task + area claims.
4. Work only in the WBS allowlist and keep out-of-area edits to a minimum. Shared contracts, root manifests and migrations require a shared task/claim.
5. Exception (OPS-001 영역 밖 예외): when waiting for another claim would block the task and the responsible developer approves, edit only the minimum files outside the area. Never delete or overwrite another person's claim ref. Record the files and reason in the task's `paths`/`scope_note` in docs/pm/wbs.json and in the PR's "Out-of-area changes" section, and tell the claim holder.
6. Merge such a PR only after a thorough check: update from main and review every out-of-area line; if the claim holder merged first, regenerate generated files (e.g. pnpm-lock.yaml) in the container instead of hand-merging; pass the full container checks (frozen lockfile), a fresh-clone check and scripts/check_scope.py; record the commands and results in the PR. If any check fails, do not merge.

## Non-negotiable requirements
- Personal macOS app, KHU LMS, initially one semester/course.
- Official Claude Code CLI with each person's subscription login. No API-key fallback, shared credential server or token extraction.
- CR-050 (2026-11-03): new native sessions run the official interactive Claude Code in its normal environment, including general/previously independent conversations. Do not claim they are isolated. Keep the previous G0 isolation proof and fixed flags for legacy structured sessions only.
- New native sessions have separate starting directories but may use Claude Code global settings, memory, skills and permissions, explicitly approved by the owner in CR-050. Never silently migrate legacy sessions or automatically approve native permission dialogs. Subscription login and no API fallback still apply.
- A then B. B recording, video originals and automatic transcription are part of full MVP.
- User-run manual collection on each Mac with no server (CR-001, ADR-002); automatic transcription; manual summarization.
- khu-ecampus-archive may be read as a reference for KHU LMS access flows (owner decision 2026-11-01, WBS-039); do not invoke it from the app, implement new modules.
- Never open/read/copy/port/refer to khu-lecture-recorder skill during implementation.
- Do not commit credentials, recordings, downloaded lectures or private course content.

## Mandatory AI self-review after every implementation step
- For each logical implementation step (function, module, or user flow), complete this loop before moving to the next step: write code → review the actual diff and relevant surrounding code/callers as a reviewer → identify bugs and design flaws → fix them → run appropriate targeted checks → review the resulting changes again. Do not defer all review to the final PR.
- Review correctness and requirements, API/data contracts and ownership, error/cancel/retry/restart paths, races, session/account boundaries, path/permission/privacy handling, compatibility and recovery. Examine failure cases and interactions, not only the happy path or the code just added. Passing tests do not replace code review.
- Fix findings within the authorized scope. Unresolved correctness, security/privacy, data-loss, isolation or acceptance-blocking defects prevent advancement of the affected step and prevent merge/Done. If a fix needs a new decision, path or claim, record the evidence and blocker and resolve authorization; never silently skip the defect or expand scope.
- After a fix, run regression tests or other checks appropriate to its risk and re-review the fix. At the final integration/PR stage, review the complete diff against current main and check for interactions missed by the individual steps.
- Keep brief evidence in the task or PR: stage and reviewed files/commit, findings (location, impact and cause), fixes, actual commands/results, re-review result and remaining risks. If no new findings were found, state the actual review scope and result; do not invent defects or claim the code is bug-free. Track non-blocking follow-ups with the reason they can remain.
- This is the implementing AI agent's own review and repair obligation; it adds no mandatory peer approval, separate agent, extra human QA card or full-suite run after every small edit. Existing claim rules, required final checks and major-feature developer self-tests still apply. Apply it to the remaining stages of work already in progress.

## Mandatory app and CLI co-development
- Read `docs/specs/SPEC-007.md` and the app/CLI workflow in `docs/DEVELOPMENT.md` before changing app behavior. For new features or user-flow changes, follow this order: define the user's journey → define the CLI verification scenarios → implement the app and necessary CLI support together → run the affected checks. Plan the scenarios first; a complete CLI implementation is not a prerequisite to writing app code.
- Before implementation, identify the entry point, navigation/selection/confirmation steps, expected result, and relevant error/cancel/retry/restart cases. Specify which steps debug must perform and which navigation steps assist may shorten. Keep the scenarios in the task or an appropriate existing test; do not create a redundant test file for every change.
- Evaluate CLI impact for every app change. Generic buttons, inputs, labels and layout changes often appear automatically through the shared renderer; verify that behavior instead of making unnecessary CLI edits. New interaction types, screens, workflows or assist shortcuts need their command/validation/scenario/documentation support updated in the same task when affected. Do not leave required CLI support as an unrecorded follow-up.
- Keep `debug` as the default for development and acceptance checks. It must follow the actual user sequence, including menus, selections and confirmations; never use raw IPC, state injection, hidden/disabled controls or assist shortcuts to claim that a debug scenario passed. Explicit `assist` may shorten supported navigation for app-control use, but must preserve account/permission boundaries and required submission/deletion/file-choice confirmations. Keep flow and shortcut evidence distinct; assist success cannot replace debug verification.
- Reuse the app's existing actions/services and the same React/CSS renderer. Do not implement a second copy of product behavior or a separate visual mockup for the CLI. Use background PNGs from that renderer when visual verification is relevant. Record fixture/local, debug/assist, commands/results and native or real-service checks that remain unrun; `NATIVE_REQUIRED` is a boundary, not a successful verification.
- For small wording/color/style-only changes, changing the app first and then checking the relevant existing CLI flow or PNG is sufficient. Run checks appropriate to the actual impact; this policy adds no mandatory new test, full-suite rerun, peer approval or human QA for every edit.
- Before merge/Done, record the CLI impact, any command/scenario/documentation changes, actual validation and remaining limitations in the task or review. If no CLI change or check is needed (for example, documentation-only work), state the reason. Required app-flow/CLI support defects block completion of the affected feature under the existing self-review rules; resolve scope/claim needs through the existing process.

## Evidence and completion
- Identify WBS/REQ IDs, spec version, allowed paths, dependency commits and acceptance tests.
- Do not label unrun tests, unimplemented features, human QA or decisions as completed.
- Explain each completed feature to a person: result, flow, execution location, data, automatic/manual boundary, failure recovery and hands-on steps.
- Routine tasks do not require human QA, peer QA, a separate QA card or peer approval. At major feature checkpoints (WBS-020 A flow, WBS-028 recording/transcription, WBS-031 app modification), the responsible developer directly tries the feature and records a short self-QA result, then continues. WBS-029 summarizes existing results rather than requiring another QA round. Do not fabricate the developer's actions.
- Update Notion WBS/QA and relevant spec via approved CR. Do not silently replace current specs with old snapshots.
- Report actual commands/results, limitations, next steps. Escalate scope changes as decisions, not assumptions.

## Git
Branch: feat|fix|spike/WBS-NNN-short-name.
Commit: type(scope): concrete behavior [WBS-NNN].
PR: task link, REQ IDs, behavior, appropriate checks, feature explanation and known limitations. Self-QA notes only for major feature checkpoints; no mandatory QA record for every task.
Initial repository bootstrap uses PM-BOOTSTRAP; subsequent product work uses WBS IDs.
Self-review and passing CI allow each developer to merge their own PR without peer approval. Routine tasks can reach Done after appropriate checks and merge. Major feature checkpoints require only the implementing developer's own functional self-test; no second developer approval. No force pushes to main.
Use scripts/claim.py on host (needs Git authentication). Never force-steal active claims.

## Checks
docker compose run --rm tools
Or: python3 scripts/check.py && python3 -m unittest discover -s tests/tooling -v
These check planning/tooling only; macOS product functionality is not implemented or validated.

