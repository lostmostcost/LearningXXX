# PM bootstrap validation · 2026-11-01

This is tooling evidence, not product acceptance or human QA.

- Host: WBS checker passed (30 unique tasks, acyclic dependency graph, spec references and scope metadata).
- Host: four real Git-remote tests passed: overlapping areas rejected without partial claims; disjoint tasks allowed; simultaneous identical task only one winner; stale receipt cannot delete a newer claim.
- Docker Desktop engine 29.9.2: Compose configuration parsed and tools container built/executed successfully on this Mac.
- Container: WBS checker and the same four coordination tests passed.
- Product CLI login, independent sessions, school data collection, app UI, recordings, STT and the second Mac remain untested. WBS tasks are not marked Done by this bootstrap.
- CI passed: https://github.com/lostmostcost/LearningXXX/actions/runs/41276245323
- GitHub repository is private. Kishibae's write permission was verified after the invitation.
- Main protection requires one review and project-checks success, with force pushes and deletion disabled.
- Notion native Share UI verified full access for the two teamspace members and workspace users. The existing permissions were preserved.

## Human review of the coordination tool

The claim command writes a unique commit and asks Git to create the task and all affected area references in one atomic push. It succeeds only if every reference is absent. The second developer can choose a different unlocked task. Release uses the exact claim commit SHA and cannot remove a later claim. This is a convention between trusted collaborators, not an access-control boundary.

Human QA still needed: each developer clones the repository, runs the common checks, claims an available task, sees a competing claim rejected, and updates Notion. Do not use an actual product task merely for a demo without agreeing and releasing it afterward.
