# Agent task
Task ID / Notion URL:
Goal:
REQ IDs / spec version:
Allowed paths:
Forbidden paths:
Claim refs:
Dependency commits:
Acceptance criteria:
User journey and relevant error/cancel/retry/restart cases (before behavior implementation):
CLI impact (automatic shared-UI coverage / new support needed / no impact and why):
Debug scenario steps / permitted assist navigation shortcuts (plan first, implement with app):
Test commands:
Mandatory review loop after each logical implementation step:
Write code → review actual diff plus related code/callers for bugs and design flaws → fix → targeted checks → re-review before advancing. Review the complete diff again at integration/PR time. Follow AGENTS.md; do not defer all review to the PR.
Self-review evidence (task or PR): stage + files/commit; finding location/impact/cause (or actual scope with no new findings); fixes; actual commands/results; re-review outcome; remaining risks/follow-up and why non-blocking.
CLI completion evidence: affected commands/scenarios/docs; actual debug and affected assist checks; fixture/local and PNG evidence when relevant; native/real-service limits. Explain unchanged CLI support or omitted CLI checks when appropriate. Follow AGENTS.md; assist success is not debug acceptance, and small style/wording or documentation edits do not require redundant new tests or full-suite runs.
Unresolved correctness/security/privacy/data-loss/isolation/acceptance blockers: stop the affected step and merge/Done until resolved. Keep scope/claim boundaries; record required decisions/authorization. Passing tests alone are not code review.
Output: user behavior, structure, changed files, actual checks, self-review findings/fixes/re-review, limitations, human QA steps when applicable, next task.
Do not mark QA passed on behalf of a person.

