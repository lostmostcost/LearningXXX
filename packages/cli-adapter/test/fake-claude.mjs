// Stand-in for the official CLI in tests. Emits stream-json shaped like the
// Claude Code 2.1.316 output recorded on 2026-11-01 (WBS-014) and records each
// invocation's argv, stdin and cwd to $FAKE_RECORD. Synthetic data only.
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const scenario = process.env.FAKE_SCENARIO ?? "ok";
const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};
const out = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (argv[0] === "--version") {
  process.stdout.write(`${process.env.FAKE_VERSION ?? "2.1.316"} (Claude Code)\n`);
  process.exit(0);
}
if (argv[0] === "auth" && argv[1] === "status") {
  const auth = {
    loggedIn: scenario !== "logged_out",
    authMethod: scenario === "api_key_auth" ? "apiKey" : "claude.ai",
    apiProvider: "firstParty",
    subscriptionType: "pro",
    email: "someone@example.test",
    orgId: "org-synthetic",
  };
  process.stdout.write(JSON.stringify(auth));
  process.exit(0);
}

const stdin = readFileSync(0, "utf8");
if (process.env.FAKE_RECORD) {
  appendFileSync(process.env.FAKE_RECORD, `${JSON.stringify({ argv, stdin, cwd: process.cwd(), scenario, claudecode: process.env.CLAUDECODE ?? null })}\n`);
}

const sessionId = scenario === "wrong_session" ? "00000000-0000-4000-8000-0000000000ff" : (flag("--session-id") ?? flag("--resume"));
const tools = (flag("--tools") ?? "").split(",").filter(Boolean);
const init = {
  type: "system",
  subtype: "init",
  cwd: process.cwd(),
  session_id: sessionId,
  tools: scenario === "extra_tool" ? [...tools, "Bash"] : tools,
  mcp_servers: scenario === "extra_mcp" ? [{ name: "synthetic-connector", status: "connected" }] : [],
  model: "claude-haiku-5-5",
  permissionMode: "dontAsk",
  apiKeySource: scenario === "api_key" ? "ANTHROPIC_API_KEY" : "none",
  claude_code_version: scenario === "old_version" ? "2.0.1" : "2.1.316",
};
const result = (fields) =>
  out({ type: "result", subtype: "success", is_error: false, result: "", session_id: sessionId, permission_denials: [], ...fields });
const assistant = (id, content) => out({ type: "assistant", message: { id, type: "message", role: "assistant", content }, session_id: sessionId });
const toolResult = (id, isError, content, meta) =>
  out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content }] }, tool_use_result: meta, session_id: sessionId });
const partial = (id, text) => {
  out({ type: "stream_event", event: { type: "message_start", message: { id } } });
  for (const piece of text.match(/.{1,4}/g)) out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: piece } } });
};

switch (scenario) {
  case "unknown_option":
    process.stderr.write("error: unknown option '--safe-mode'\n");
    process.exit(1);
  case "session_not_found":
    out({ type: "result", subtype: "error_during_execution", is_error: true, session_id: sessionId });
    process.stderr.write(`No conversation found with session ID: ${sessionId}\n`);
    process.exit(1);
}

out(init);
switch (scenario) {
  case "ok":
  case "old_version":
    partial("msg_1", `echo:${stdin}`);
    assistant("msg_1", [{ type: "text", text: `echo:${stdin}` }]);
    assistant("msg_2", [{ type: "text", text: " (unstreamed)" }]);
    out({ type: "rate_limit_event", rate_limit_info: { status: "allowed", resetsAt: 1793534400 } });
    result({ result: `echo:${stdin}` });
    process.exit(0);
  case "attachment_read": {
    const dirs = argv.flatMap((value, i) => value === "--add-dir" ? [argv[i + 1]] : []);
    const contents = [];
    for (const dir of dirs) for (const name of readdirSync(dir)) {
      const path = join(dir, name), id = `read_${contents.length}`;
      assistant("msg_read", [{ type: "tool_use", id, name: "Read", input: { file_path: path } }]);
      contents.push(readFileSync(path, "utf8"));
      toolResult(id, false, "Read synthetic selected file");
    }
    assistant("msg_answer", [{ type: "text", text: `attachment:${contents.join("|")}` }]);
    result({ result: "read attachments" });
    process.exit(0);
  }
  case "write_attachment": {
    const target = join(flag("--add-dir"), "input.txt");
    assistant("msg_write", [{ type: "tool_use", id: "write_attachment", name: "Write", input: { file_path: target } }]);
    toolResult("write_attachment", false, "claimed write success");
    await sleep(5000);
    process.exit(0);
  }
  case "write_file": {
    mkdirSync(join(process.cwd(), "notes"), { recursive: true });
    assistant("msg_1", [{ type: "tool_use", id: "toolu_w1", name: "Write", input: { file_path: join(process.cwd(), "notes/summary.md"), content: "x" } }]);
    writeFileSync(join(process.cwd(), "notes/summary.md"), "synthetic\n");
    toolResult("toolu_w1", undefined, "File created", { type: "create" });
    assistant("msg_2", [{ type: "tool_use", id: "toolu_e1", name: "Edit", input: { file_path: "notes/summary.md" } }]);
    toolResult("toolu_e1", undefined, "Edited", { type: "update" });
    assistant("msg_3", [{ type: "text", text: "done" }]);
    result({ result: "done" });
    process.exit(0);
  }
  case "write_external": {
    const target = join(process.env.FAKE_EXTERNAL, "report.md");
    assistant("msg_1", [{ type: "tool_use", id: "toolu_w1", name: "Write", input: { file_path: target, content: "x" } }]);
    writeFileSync(target, "synthetic\n");
    toolResult("toolu_w1", undefined, "File created", { type: "create" });
    assistant("msg_2", [{ type: "text", text: "done" }]);
    result({ result: "done" });
    process.exit(0);
  }
  case "outside_denied":
    assistant("msg_1", [{ type: "tool_use", id: "toolu_r1", name: "Read", input: { file_path: "/etc/hosts" } }]);
    toolResult("toolu_r1", true, "/etc/hosts is outside the working directory");
    assistant("msg_2", [{ type: "text", text: "I could not read it." }]);
    result({ result: "I could not read it.", permission_denials: [{ tool_name: "Read", tool_use_id: "toolu_r1" }] });
    process.exit(0);
  case "outside_executed":
  case "symlink_executed":
    assistant("msg_1", [{ type: "tool_use", id: "toolu_r1", name: "Read", input: { file_path: scenario === "outside_executed" ? "/etc/hosts" : "escape/secret.txt" } }]);
    toolResult("toolu_r1", false, "SYNTHETIC-CANARY");
    await sleep(5000);
    result({ result: "leaked" });
    process.exit(0);
  case "api_key":
    result({ is_error: true, result: "Invalid API key · Fix external API key" });
    process.exit(1);
  case "auth_expired":
    result({ is_error: true, result: "OAuth token has expired. Please run /login" });
    process.exit(1);
  case "usage_limit":
    out({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1793534400 } });
    result({ is_error: true, result: "Claude usage limit reached" });
    process.exit(1);
  case "crash":
    process.stderr.write(`fatal at ${process.env.HOME}/private/thing\n`);
    process.exit(3);
  case "slow":
  case "stubborn": {
    if (scenario === "stubborn") process.on("SIGTERM", () => undefined);
    assistant("msg_1", [{ type: "tool_use", id: "toolu_w1", name: "Write", input: { file_path: "draft.md" } }]);
    writeFileSync(join(process.cwd(), "draft.md"), "partial\n");
    toolResult("toolu_w1", undefined, "File created", { type: "create" });
    for (;;) {
      partial(`msg_${Date.now()}`, "tick");
      await sleep(50);
    }
  }
  default:
    // extra_tool, extra_mcp, wrong_session: the adapter must stop before run.started.
    await sleep(5000);
    result({ result: "should not be read" });
    process.exit(0);
}
