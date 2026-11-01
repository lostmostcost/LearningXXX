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
- G0 must prove execution, file access, resume and independent-session isolation.
- Independent sessions have no automatic course/history/memory/filesystem context. Do not implement isolation with prompt wording alone.
- A then B. B recording, video originals and automatic transcription are part of full MVP.
- User-run manual collection on each Mac with no server (CR-001, ADR-002); automatic transcription; manual summarization.
- Do not copy/invoke legacy khu-ecampus-archive code; implement new modules.
- Never open/read/copy/port/refer to khu-lecture-recorder skill during implementation.
- Do not commit credentials, recordings, downloaded lectures or private course content.

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

