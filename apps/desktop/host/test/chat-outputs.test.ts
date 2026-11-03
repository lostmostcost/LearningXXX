import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatOutputs, writtenPaths } from "../src/chat-outputs.ts";

const SID = "33333333-3333-4333-8333-333333333333";
const tool = (name: string, input: unknown) => ({ tools: [{ name, input: JSON.stringify(input) }] });

async function setup() {
  const base = await realpath(await mkdtemp(join(tmpdir(), "chat-outputs-")));
  const cwd = join(base, SID), elsewhere = join(base, "Desktop"), course = join(base, "course-copy");
  await mkdir(cwd); await mkdir(elsewhere); await mkdir(course);
  await writeFile(join(cwd, "notes.md"), "# 요약\n본문");
  await mkdir(join(cwd, "outputs")); await writeFile(join(cwd, "outputs", "table.csv"), "a,b");
  await writeFile(join(cwd, ".chat-ui.json"), "{}");
  await writeFile(join(cwd, ".learningxxx-session.json"), "{}");
  await mkdir(join(cwd, "node_modules")); await writeFile(join(cwd, "node_modules", "x.js"), "");
  await writeFile(join(course, "lecture.pdf"), "%PDF");
  await symlink(course, join(cwd, "course"));
  await writeFile(join(elsewhere, "report.docx"), "doc");
  await writeFile(join(elsewhere, "run.command"), "#!/bin/sh");
  await writeFile(join(base, "secret.txt"), "not made by the chat");
  await symlink(join(base, "secret.txt"), join(cwd, "link.txt"));
  const messages = [
    tool("Write", { file_path: join(elsewhere, "report.docx"), content: "" }),
    tool("Edit", { file_path: join(elsewhere, "run.command"), old_string: "", new_string: "" }),
    tool("Write", { file_path: join(elsewhere, "deleted.md"), content: "" }),
    tool("Read", { file_path: join(base, "secret.txt") }),
    tool("Write", { file_path: "notes.md", content: "" }),
  ];
  const opened: string[] = [], revealed: string[] = [];
  const outputs = new ChatOutputs({
    workspace: (id) => { if (id !== SID) throw new Error("unknown"); return { cwd, messages }; },
    openPath: async (path) => { opened.push(path); return ""; }, reveal: (path) => { revealed.push(path); },
  });
  return { base, cwd, elsewhere, outputs, opened, revealed, done: () => rm(base, { recursive: true, force: true }) };
}

describe("writtenPaths", () => {
  it("takes file paths of writing tools only, relative ones against the folder", () => {
    assert.deepEqual(writtenPaths([tool("Write", { file_path: "a.md" }), tool("NotebookEdit", { notebook_path: "/x/n.ipynb" }), tool("Read", { file_path: "/x/r" }), { tools: [{ name: "Write", input: "not json" }] }], "/w"), ["/w/a.md", "/x/n.ipynb"]);
  });
});

describe("ChatOutputs", () => {
  it("lists the folder's files and files written elsewhere, without bookkeeping, links or the course copy", async () => {
    const t = await setup();
    try {
      const { files } = await t.outputs.list(SID);
      const byName = Object.fromEntries(files.map((f) => [f.name, f]));
      assert.deepEqual(Object.keys(byName).sort(), ["notes.md", "report.docx", "run.command", "table.csv"]);
      assert.equal(byName["notes.md"]!.where, "folder");
      assert.equal(byName["table.csv"]!.location, join("outputs", "table.csv"));
      assert.equal(byName["report.docx"]!.where, "elsewhere");
      assert.equal(byName["notes.md"]!.kind, "text");
      assert.equal(byName["report.docx"]!.openable, true);
      assert.equal(byName["run.command"]!.openable, false);
    } finally { await t.done(); }
  });

  it("reads text, opens documents, reveals anything listed, and refuses the rest", async () => {
    const t = await setup();
    try {
      const { files } = await t.outputs.list(SID);
      const id = (name: string) => files.find((f) => f.name === name)!.id;
      assert.deepEqual(await t.outputs.read(SID, id("notes.md")), { text: "# 요약\n본문" });
      await assert.rejects(t.outputs.read(SID, id("report.docx")), /글 파일만/);
      await t.outputs.show(SID, id("report.docx"), "open");
      assert.deepEqual(t.opened, [join(t.elsewhere, "report.docx")]);
      await assert.rejects(t.outputs.show(SID, id("run.command"), "open"), /바로 열지 않습니다/);
      await t.outputs.show(SID, id("run.command"), "reveal");
      assert.deepEqual(t.revealed, [join(t.elsewhere, "run.command")]);
      await assert.rejects(t.outputs.show(SID, "f".repeat(32), "open"), /찾을 수 없습니다/);
      await assert.rejects(t.outputs.list("44444444-4444-4444-8444-444444444444"), /unknown/);
    } finally { await t.done(); }
  });
});
