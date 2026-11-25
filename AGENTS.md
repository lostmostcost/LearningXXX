# LearningXXX agent contract

This repository is the single source of truth. Since 2026-11-26 the project is no longer run for a competition or as a two-person Notion-managed plan: the AI agent leads development under the owner's direction. The old Notion PM hub (WBS, specs, CRs, QA cards) is archived; do not read it or wait on it. Its links in repository documents are history only.

## How the agent works
1. Read README.md, docs/specs/PRD-001.md, the relevant SPEC, docs/specs/OPS-001.md and docs/specs/QA-001.md. The repository copies are authoritative.
2. Take the next work from the owner's instructions first; otherwise pick it yourself from known defects, docs/pm/backlog.md, open follow-ups in docs/pm/wbs.json and docs/pm/reviews/, and gaps against PRD-001. Prefer user-visible failures and data-loss risks.
3. Record each task in docs/pm/wbs.json before or with the change (ID, title, deps, areas, paths, spec, REQ IDs, acceptance, status, branch, scope_note, review_evidence). `url` is optional. Keep status current in the repository.
4. Decide implementation, scope and design questions yourself with the recommended option and record the reason in the task, the review file or docs/decisions/. No CR or approval round is needed. Ask the owner only for what is genuinely theirs: product direction they have not set, privacy/credential/account matters, irreversible or outward actions not already requested, and changes to the non-negotiable requirements below.
5. Keep each change focused on its task. Claims (scripts/claim.py) are needed only when another person or agent works in the same repository at the same time; then never delete or overwrite someone else's claim ref.
6. Shared contracts, root manifests, lockfiles and migrations may change when the task needs them; regenerate generated files (e.g. pnpm-lock.yaml) in the container instead of hand-editing, and run the full checks before merge.

## Non-negotiable requirements
- Personal macOS app for KHU LMS students; design for any student, not only the owner's own courses or files.
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
- Fix findings. Unresolved correctness, security/privacy, data-loss, isolation or acceptance-blocking defects prevent advancement of the affected step and prevent merge/Done. If a fix needs a decision, make it with the recommended option and record it; ask the owner only for owner-level matters (see How the agent works). Never silently skip a defect.
- After a fix, run regression tests or other checks appropriate to its risk and re-review the fix. At the final integration/PR stage, review the complete diff against current main and check for interactions missed by the individual steps.
- Keep brief evidence in the task or PR: stage and reviewed files/commit, findings (location, impact and cause), fixes, actual commands/results, re-review result and remaining risks. If no new findings were found, state the actual review scope and result; do not invent defects or claim the code is bug-free. Track non-blocking follow-ups with the reason they can remain.
- This is the implementing AI agent's own review and repair obligation; it adds no mandatory peer approval, separate agent, extra human QA card or full-suite run after every small edit. Required final checks still apply. Apply it to the remaining stages of work already in progress.

## Mandatory app and CLI co-development
- Read `docs/specs/SPEC-007.md` and the app/CLI workflow in `docs/DEVELOPMENT.md` before changing app behavior. For new features or user-flow changes, follow this order: define the user's journey → define the CLI verification scenarios → implement the app and necessary CLI support together → run the affected checks. Plan the scenarios first; a complete CLI implementation is not a prerequisite to writing app code.
- Before implementation, identify the entry point, navigation/selection/confirmation steps, expected result, and relevant error/cancel/retry/restart cases. Specify which steps debug must perform and which navigation steps assist may shorten. Keep the scenarios in the task or an appropriate existing test; do not create a redundant test file for every change.
- Evaluate CLI impact for every app change. Generic buttons, inputs, labels and layout changes often appear automatically through the shared renderer; verify that behavior instead of making unnecessary CLI edits. New interaction types, screens, workflows or assist shortcuts need their command/validation/scenario/documentation support updated in the same task when affected. Do not leave required CLI support as an unrecorded follow-up.
- Keep `debug` as the default for development and acceptance checks. It must follow the actual user sequence, including menus, selections and confirmations; never use raw IPC, state injection, hidden/disabled controls or assist shortcuts to claim that a debug scenario passed. Explicit `assist` may shorten supported navigation for app-control use, but must preserve account/permission boundaries and required submission/deletion/file-choice confirmations. Keep flow and shortcut evidence distinct; assist success cannot replace debug verification.
- Reuse the app's existing actions/services and the same React/CSS renderer. Do not implement a second copy of product behavior or a separate visual mockup for the CLI. Use background PNGs from that renderer when visual verification is relevant. Record fixture/local, debug/assist, commands/results and native or real-service checks that remain unrun; `NATIVE_REQUIRED` is a boundary, not a successful verification.
- For small wording/color/style-only changes, changing the app first and then checking the relevant existing CLI flow or PNG is sufficient. Run checks appropriate to the actual impact; this policy adds no mandatory new test, full-suite rerun, peer approval or human QA for every edit.
- Before merge/Done, record the CLI impact, any command/scenario/documentation changes, actual validation and remaining limitations in the task or review. If no CLI change or check is needed (for example, documentation-only work), state the reason. Required app-flow/CLI support defects block completion of the affected feature under the existing self-review rules; record any follow-up in docs/pm/wbs.json.

## Evidence and completion
- Identify the WBS/REQ IDs, spec section, paths, base commit and acceptance checks.
- Do not label unrun tests, unimplemented features, human checks or owner decisions as completed.
- Explain each completed feature to a person: result, flow, execution location, data, automatic/manual boundary, failure recovery and hands-on steps.
- Verify in the real app or with real engines/services yourself when the change is observable there; record what stayed unverified. The owner's own hands-on testing is optional and never fabricated.
- Update the relevant docs/specs section in the same change when behavior or requirements change; keep docs/pm/wbs.json and docs/pm/reviews/WBS-NNN.md current.
- Report actual commands/results, limitations and next steps.

## Git
Branch: feat|fix|spike|docs|chore/WBS-NNN-short-name.
Commit: type(scope): concrete behavior [WBS-NNN].
PR: REQ IDs, behavior, checks run, feature explanation and known limitations.
main is protected (required `project-checks`, linear history): push the branch, open a PR, and after self-review and passing CI the agent merges it itself (squash). No peer approval. No force pushes to main.

## Checks
docker compose run --rm tools
Or: python3 scripts/check.py && python3 -m unittest discover -s tests/tooling -v
These check planning/tooling only; macOS product functionality is not implemented or validated.

