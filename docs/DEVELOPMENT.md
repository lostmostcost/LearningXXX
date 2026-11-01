# Common environment and collaboration

## Environment
Install Docker Desktop and host Git/Python 3.12+. Run `docker compose run --rm tools`.
The tools image does not implement the application. Product runtime choice belongs to ADR-002.
No personal Claude/LMS credentials or host home mount is used.
Mac host checks: macOS/CPU, official CLI version, subscription login, microphone, keychain, UI execution.
These checks are WBS-001/002/005, not passed by the repository bootstrap.

The initial image pins the Python patch tag and multi-platform base digest. Apt packages are installed from Debian repositories; the image build is not a complete reproducible-build guarantee. WBS-005 must record the final built image digest for both developers and pin service dependencies after the stack decision.
The devcontainer uses the same read-only source mount for checks; edit source on the host. A writable app development service is added after the stack decision.

## Atomic work claims
Notion is not an atomic lock. On the host, after checking live Ready/dependencies:

```sh
git fetch origin
python3 scripts/claim.py acquire WBS-001 --ready-confirmed
git switch -c spike/WBS-001-cli-proof origin/main
```

The command reads allowed areas from docs/pm/wbs.json and atomically creates task and area refs with empty expected values. All refs must be absent. A competing claim fails without partial locks. The unique claim commit records Git identity, task, timestamp and nonce. This is coordination between trusted repository writers, not a security boundary against malicious collaborators.

Update Notion owner/start/branch after success. Each person should hold one implementation task.
Read current locks: `git ls-remote origin 'refs/heads/claims/*'`.
Local receipts are in Git's common directory under learningxxx-claims, shared by worktrees. Preserve the receipt until release. If network response is uncertain, retain it and inspect remote refs before retrying; never force-steal.

After appropriate checks/merge (and developer self-testing at major feature checkpoints), or a documented handoff:
```sh
python3 scripts/claim.py release WBS-001
```

Release deletes all recorded refs atomically with an expected-SHA lease; it cannot remove a newer owner's claim. No expiry or automatic takeover. A lost clone/receipt requires an explicitly coordinated manual recovery by both humans.

The script does not synchronize Notion or verify live Ready/dependency state: `--ready-confirmed` is your explicit acknowledgment after reading Notion, not an automated gate.
Changing task areas requires a shared planning change first. Keep edits inside the WBS paths. An out-of-area edit is an approved exception only (OPS-001 영역 밖 예외): minimum files, recorded in `paths`/`scope_note` and the PR, the claim holder informed, and a thorough pre-merge check (fresh main, line-by-line review of out-of-area diffs, regenerated generated files, full container checks with the frozen lockfile, fresh clone, scope check). Check a branch's allowed paths:
```sh
python3 scripts/check_scope.py WBS-001 origin/main
```
Include uncommitted/untracked paths in review; the scope script checks committed branch differences only.
Shared root/config changes use a shared task; unrelated directories do not imply permission to change shared APIs.

## Completion
Self-review + passing CI → author may merge their own PR. Routine tasks then proceed to Done without QA cards or peer QA. Only major feature checkpoints WBS-020/028/031 require the responsible developer to directly test the feature and record a brief self-QA result. No peer approval is needed; WBS-029 summarizes existing results.
Notion dates, assignees and QA outcomes are blank until real work occurs.
CI currently checks the WBS graph and coordination tooling. It does not run LMS, Claude, GUI, recording or transcription.

