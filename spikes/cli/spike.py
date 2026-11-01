#!/usr/bin/env python3
"""WBS-001 spike: prove the official Claude Code CLI works on a subscription login.

Runs real CLI calls in a disposable workspace and judges results from the file
system and CLI events, never from the model's claims alone. Standard library only.

    python3.13 spikes/cli/spike.py --evidence spikes/cli/evidence/run.json
"""
import argparse
import datetime
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import uuid

MODEL = "haiku"
TIMEOUT_SECONDS = 180
# Any of these would route the CLI away from the personal subscription login.
FORBIDDEN_ENV = (
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
)
# Set when this harness is launched from inside a Claude Code session.
SESSION_ENV = ("CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT")
BASE_FLAGS = (
    "--model", MODEL,
    "--output-format", "stream-json",
    "--verbose",
    "--strict-mcp-config",
    "--setting-sources", "project",
    "--permission-mode", "dontAsk",
)
FILE_TOOLS = ("--tools", "Read,Write,Edit,Bash")
# Deliberately one exact command: no broad Bash allowance (SPEC-002).
FILE_ALLOW = ("--allowedTools", "Read", "Write", "Edit", "Bash(rm fixture.txt)")
NO_TOOLS = ("--tools", "")


def find_forbidden_env(env):
    return sorted(name for name in FORBIDDEN_ENV if env.get(name))


def child_env(extra=None):
    env = {k: v for k, v in os.environ.items() if k not in SESSION_ENV}
    env.update(extra or {})
    return env


def parse_events(stdout):
    """Reduce stream-json output to the fields evidence needs."""
    parsed = {"init": None, "result": None, "tools": [], "unparsed_lines": 0}
    for line in stdout.splitlines():
        if not line.strip():
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            parsed["unparsed_lines"] += 1
            continue
        if event.get("type") == "system" and event.get("subtype") == "init":
            parsed["init"] = event
        elif event.get("type") == "result":
            parsed["result"] = event
        elif event.get("type") == "assistant":
            for block in event.get("message", {}).get("content", []):
                if block.get("type") == "tool_use":
                    parsed["tools"].append(block.get("name"))
    return parsed


def redact(text, workspace):
    text = text.replace(str(workspace), "<workspace>")
    return text.replace(str(pathlib.Path.home()), "<home>")


def call_cli(binary, prompt, workspace, flags=(), env_extra=None):
    command = [binary, "-p", prompt, *BASE_FLAGS, *flags]
    done = subprocess.run(command, cwd=workspace, env=child_env(env_extra),
                          stdin=subprocess.DEVNULL, capture_output=True, text=True,
                          timeout=TIMEOUT_SECONDS)
    parsed = parse_events(done.stdout)
    init, result = parsed["init"] or {}, parsed["result"] or {}
    return {
        "exit_code": done.returncode,
        "api_key_source": init.get("apiKeySource"),
        "cli_version": init.get("claude_code_version"),
        "model": init.get("model"),
        "permission_mode": init.get("permissionMode"),
        "session_id": result.get("session_id") or init.get("session_id"),
        "is_error": result.get("is_error"),
        "subtype": result.get("subtype"),
        "answer": redact(str(result.get("result", "")), workspace),
        "tools_used": parsed["tools"],
        "permission_denials": len(result.get("permission_denials") or []),
        "stderr": redact(done.stderr.strip(), workspace)[:500],
    }


def succeeded(call):
    return (call["exit_code"] == 0 and call["is_error"] is False
            and call["api_key_source"] == "none")


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def preflight(binary):
    version = subprocess.run([binary, "--version"], capture_output=True, text=True,
                             timeout=30)
    status = subprocess.run([binary, "auth", "status"], capture_output=True, text=True,
                            timeout=30)
    auth = json.loads(status.stdout)
    # Allowlist on purpose: email and organization fields stay out of evidence.
    return {
        "cli_version": version.stdout.strip(),
        "logged_in": auth.get("loggedIn"),
        "auth_method": auth.get("authMethod"),
        "api_provider": auth.get("apiProvider"),
        "subscription_type": auth.get("subscriptionType"),
    }


def scenario_request_response(binary, workspace, nonce):
    token = f"PONG-{nonce}"
    call = call_cli(binary, f"Reply with exactly: {token}", workspace, NO_TOOLS)
    return {"passed": succeeded(call) and call["answer"].strip() == token, "call": call}


def scenario_files(binary, workspace, nonce):
    fixture = workspace / "fixture.txt"
    bystander = workspace / "keep.txt"
    bystander.write_text(f"untouched-{nonce}\n")
    before = sha256(bystander)
    flags = (*FILE_TOOLS, *FILE_ALLOW)
    alpha, beta = f"alpha-{nonce}", f"beta-{nonce}"

    create = call_cli(binary, f"Use the Write tool to create fixture.txt in the current "
                      f"directory containing exactly this one line: {alpha}",
                      workspace, flags)
    created = fixture.exists() and fixture.read_text().strip() == alpha

    modify = call_cli(binary, f"Read fixture.txt, then use the Edit tool to replace "
                      f"{alpha} with {beta}. Change nothing else.", workspace, flags)
    modified = fixture.exists() and fixture.read_text().strip() == beta

    delete = call_cli(binary, "Use the Bash tool to run exactly this command: "
                      "rm fixture.txt", workspace, flags)
    deleted = not fixture.exists()

    return {
        "passed": all((created, modified, deleted, succeeded(create),
                       succeeded(modify), succeeded(delete),
                       sha256(bystander) == before)),
        "created_on_disk": created,
        "modified_on_disk": modified,
        "deleted_on_disk": deleted,
        "bystander_unchanged": sha256(bystander) == before,
        "calls": {"create": create, "modify": modify, "delete": delete},
    }


def scenario_resume(binary, workspace, nonce):
    session_id = str(uuid.uuid4())
    word = f"zephyr-{nonce}"
    ask = "What is the code word from earlier in this conversation? " \
          "If you were not told one, reply exactly: UNKNOWN"
    first = call_cli(binary, f"Remember this code word: {word}. Reply only: STORED",
                     workspace, (*NO_TOOLS, "--session-id", session_id))
    resumed = call_cli(binary, ask, workspace, (*NO_TOOLS, "--resume", session_id))
    control = call_cli(binary, ask, workspace, NO_TOOLS)
    return {
        "passed": all((succeeded(first), succeeded(resumed), succeeded(control),
                       word in resumed["answer"], word not in control["answer"],
                       resumed["session_id"] == session_id,
                       control["session_id"] != session_id)),
        "recalled_after_process_exit": word in resumed["answer"],
        "same_session_id": resumed["session_id"] == session_id,
        "control_session_leaked": word in control["answer"],
        "calls": {"first": first, "resumed": resumed, "control": control},
    }


def failure_boundaries(binary, workspace):
    """Observed behavior, recorded as facts rather than pass/fail."""
    unknown = call_cli(binary, "Reply: OK", workspace,
                       (*NO_TOOLS, "--resume", str(uuid.uuid4())))
    # A fake key shows what the CLI does when a key exists. It proves nothing is
    # billed only if the call fails, which is why the harness also refuses such runs.
    fake_key = call_cli(binary, "Reply: OK", workspace, NO_TOOLS,
                        {"ANTHROPIC_API_KEY": "sk-ant-fake-wbs001-not-a-real-key"})
    try:
        subprocess.run(["claude-not-installed-wbs001", "--version"], capture_output=True)
        missing = "unexpectedly ran"
    except FileNotFoundError:
        missing = "FileNotFoundError before any request"
    return {"unknown_session_id": unknown, "api_key_in_env": fake_key,
            "cli_not_installed": missing}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", required=True, type=pathlib.Path)
    parser.add_argument("--workspace-root", type=pathlib.Path)
    args = parser.parse_args()

    forbidden = find_forbidden_env(os.environ)
    if forbidden:
        print(f"Refusing to run, subscription path not selected: {forbidden}",
              file=sys.stderr)
        return 2
    binary = shutil.which("claude")
    if not binary:
        print("Refusing to run: official claude CLI not found", file=sys.stderr)
        return 2

    environment = preflight(binary)
    if environment["auth_method"] != "claude.ai":
        print(f"Refusing to run: auth method {environment['auth_method']}", file=sys.stderr)
        return 2

    root = tempfile.mkdtemp(prefix="wbs001-", dir=args.workspace_root)
    workspace = pathlib.Path(root).resolve()
    nonce = uuid.uuid4().hex[:8]
    try:
        scenarios = {
            "request_response": scenario_request_response(binary, workspace, nonce),
            "file_create_modify_delete": scenario_files(binary, workspace, nonce),
            "resume_same_session": scenario_resume(binary, workspace, nonce),
        }
        failures = failure_boundaries(binary, workspace)
    finally:
        shutil.rmtree(workspace, ignore_errors=True)

    evidence = {
        "task": "WBS-001",
        "recorded_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "environment": environment,
        "flags": list(BASE_FLAGS),
        "scenarios": scenarios,
        "failure_boundaries": failures,
    }
    args.evidence.parent.mkdir(parents=True, exist_ok=True)
    args.evidence.write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n")
    for name, outcome in scenarios.items():
        print(f"{'PASS' if outcome['passed'] else 'FAIL'}  {name}")
    return 0 if all(s["passed"] for s in scenarios.values()) else 1


if __name__ == "__main__":
    sys.exit(main())
