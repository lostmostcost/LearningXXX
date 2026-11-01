# LearningXXX agent contract

## Read before work
1. Read README.md, docs/specs/PRD-001.md, relevant SPEC, OPS-001 and QA-001.
2. Read current Notion WBS and approved CRs. Snapshot statuses are not current authorization.
3. Confirm task is Ready, dependencies Done, and you hold task + area claims.
4. Work only in the WBS allowlist. Shared contracts, root manifests and migrations require a shared task/claim. Never edit another claimed area.

## Non-negotiable requirements
- Personal macOS app, KHU LMS, initially one semester/course.
- Official Claude Code CLI with each person's subscription login. No API-key fallback, shared credential server or token extraction.
- G0 must prove execution, file access, resume and independent-session isolation.
- Independent sessions have no automatic course/history/memory/filesystem context. Do not implement isolation with prompt wording alone.
- A then B. B recording, video originals and automatic transcription are part of full MVP.
- Automatic collection and transcription; manual summarization.
- Do not copy/invoke legacy khu-ecampus-archive code; implement new modules.
- Never open/read/copy/port/refer to khu-lecture-recorder skill during implementation.
- Do not commit credentials, recordings, downloaded lectures or private course content.

## Evidence and completion
- Identify WBS/REQ IDs, spec version, allowed paths, dependency commits and acceptance tests.
- Do not label unrun tests, unimplemented features, human QA or decisions as completed.
- Explain each completed feature to a person: result, flow, execution location, data, automatic/manual boundary, failure recovery and hands-on steps.
- Human QA is required; AI cannot supply a human's signoff.
- Update Notion WBS/QA and relevant spec via approved CR. Do not silently replace current specs with old snapshots.
- Report actual commands/results, limitations, next steps. Escalate scope changes as decisions, not assumptions.

## Git
Branch: feat|fix|spike/WBS-NNN-short-name.
Commit: type(scope): concrete behavior [WBS-NNN].
PR: task link, REQ IDs, behavior, tests, feature explanation, QA record, known limitations.
Initial repository bootstrap uses PM-BOOTSTRAP; subsequent product work uses WBS IDs.
Self-review and passing CI allow each developer to merge their own PR without peer approval. Human QA remains required for WBS Done and can follow merge. No force pushes to main.
Use scripts/claim.py on host (needs Git authentication). Never force-steal active claims.

## Checks
docker compose run --rm tools
Or: python3 scripts/check.py && python3 -m unittest discover -s tests/tooling -v
These check planning/tooling only; macOS product functionality is not implemented or validated.

