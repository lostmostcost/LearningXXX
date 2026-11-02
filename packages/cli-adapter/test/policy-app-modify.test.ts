import assert from "node:assert/strict";
import { test } from "node:test";
import { APP_MODIFY_TOOLS, buildArgs } from "../src/index.ts";

const args = buildArgs({ mode: "app_modify", cliSessionId: "00000000-0000-4000-8000-000000000001", resume: false, attachmentDirs: [] });

test("app modification has no Bash, so the CLI can neither run nor delete anything", () => {
  assert.deepEqual([...APP_MODIFY_TOOLS], ["Read", "Glob", "Grep", "Write", "Edit"]);
  assert.equal(args[args.indexOf("--tools") + 1], "Read,Glob,Grep,Write,Edit");
});

test("app modification skips the checkout's own instructions and connectors", () => {
  for (const flag of ["--restricted", "--safe-mode", "--strict-mcp-config", "--disable-slash-commands"]) assert.ok(args.includes(flag), flag);
});
