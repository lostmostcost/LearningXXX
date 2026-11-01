#!/usr/bin/env python3
"""Mac host checklist (WBS-005). Reads only; never calls Claude for a model request.

Automatic checks: macOS/CPU, Git identity and remote access, Python, Docker,
Node/pnpm pins, official Claude CLI absolute path/version/subscription login,
and forbidden credential environment variables.
Manual items (microphone, screen capture, keychain, GUI launch) are listed as
MANUAL: they are validated by WBS-011/014/023 in the real app, not here.
"""
import argparse
import json
import os
import pathlib
import platform
import re
import shutil
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
TOOLCHAIN = json.loads((ROOT / "infra/dev/toolchain.json").read_text())

# Same list as spikes/cli/spike.py: any of these routes the CLI away from the
# personal subscription login (REQ-001).
FORBIDDEN_ENV = (
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
)
# Finder-launched apps do not inherit the shell PATH (ADR-002), so the app must
# probe absolute locations. These are the locations it should try.
CLAUDE_CANDIDATES = (
    "~/.local/bin/claude",
    "~/.claude/local/claude",
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
)
MANUAL = (
    ("microphone", "마이크 권한: WBS-023 녹음 구현 시 서명 안 된 로컬 빌드에서 확인"),
    ("screen_capture", "화면 캡처 권한: WBS-016 캡처 구현 시 확인"),
    ("keychain", "키체인 저장/조회: LMS 인증 저장 구현(WBS-007) 시 확인"),
    ("gui_cli_login", "Finder로 실행한 앱에서 구독 CLI 로그인 동작: WBS-011/014 첫 구현에서 확인"),
)

PASS, FAIL, WARN, MANUAL_STATUS = "PASS", "FAIL", "WARN", "MANUAL"


def run(args, timeout=30):
    try:
        result = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as error:
        return None, str(error)
    return result.returncode, (result.stdout.strip() or result.stderr.strip())


def version_tuple(text):
    match = re.search(r"(\d+)\.(\d+)(?:\.(\d+))?", text or "")
    return tuple(int(x or 0) for x in match.groups()) if match else None


def check_os():
    if sys.platform != "darwin":
        return FAIL, f"{platform.system()} (macOS host required)"
    return PASS, f"macOS {platform.mac_ver()[0]} {platform.machine()}"


def check_python():
    have = sys.version_info[:2]
    need = version_tuple(TOOLCHAIN["python"]["host_min"])[:2]
    status = PASS if have >= need else FAIL
    return status, f"{platform.python_version()} (min {TOOLCHAIN['python']['host_min']})"


def check_git_identity():
    _, name = run(["git", "config", "user.name"])
    _, email = run(["git", "config", "user.email"])
    if not name or not email:
        return FAIL, "git user.name/user.email not set (claim records Git identity)"
    return PASS, "configured"


def check_git_remote():
    code, out = run(["git", "-C", str(ROOT), "ls-remote", "--heads", "origin", "main"], 60)
    if code != 0:
        return FAIL, f"origin unreachable: {out[:120]}"
    return PASS, "origin main reachable (claim.py needs push access)"


def check_docker():
    if not shutil.which("docker"):
        return FAIL, "docker not installed"
    code, out = run(["docker", "info", "--format", "{{.ServerVersion}}"], 60)
    if code != 0:
        return FAIL, "docker daemon not running"
    return PASS, f"server {out}"


def compare_pin(name, out, want):
    have = version_tuple(out)
    if have is None:
        return FAIL, f"{name} version unreadable"
    if have == version_tuple(want):
        return PASS, out
    if have[0] == version_tuple(want)[0]:
        return WARN, f"{out} (pinned {want}; same major)"
    return FAIL, f"{out} (pinned {want})"


def check_node():
    if not shutil.which("node"):
        return FAIL, f"node not found (Electron host needs Node {TOOLCHAIN['node']['version']})"
    _, out = run(["node", "--version"])
    return compare_pin("node", out, TOOLCHAIN["node"]["version"])


def check_pnpm():
    if not shutil.which("pnpm"):
        return FAIL, f"pnpm not found (use: corepack enable pnpm; pinned {TOOLCHAIN['pnpm']['version']})"
    _, out = run(["pnpm", "--version"])
    return compare_pin("pnpm", out, TOOLCHAIN["pnpm"]["version"])


def find_claude():
    for candidate in CLAUDE_CANDIDATES:
        path = pathlib.Path(candidate).expanduser()
        if path.is_file() and os.access(path, os.X_OK):
            return str(path)
    return None


def check_claude(binary):
    if not binary:
        on_path = shutil.which("claude")
        hint = f"; PATH has {on_path} but app cannot rely on PATH" if on_path else ""
        return FAIL, "official CLI not found at known absolute paths" + hint
    _, out = run([binary, "--version"])
    verified = TOOLCHAIN["claude_cli"]["verified"]
    if version_tuple(out) != version_tuple(verified):
        return WARN, f"{binary} {out} (isolation verified on {verified}; rerun spikes/cli/isolation.py)"
    return PASS, f"{binary} {out}"


def parse_auth(stdout):
    """Allowlist auth fields; email/organization never enter evidence."""
    auth = json.loads(stdout)
    return {key: auth.get(key) for key in
            ("loggedIn", "authMethod", "apiProvider", "subscriptionType")}


def judge_auth(auth):
    if not auth.get("loggedIn"):
        return FAIL, "not logged in (run: claude, then /login)"
    if auth.get("authMethod") != "claude.ai":
        return FAIL, f"auth method {auth.get('authMethod')} (subscription login required)"
    return PASS, f"claude.ai login, {auth.get('subscriptionType')}"


def check_auth(binary):
    if not binary:
        return FAIL, "skipped: CLI missing"
    code, out = run([binary, "auth", "status"])
    try:
        return judge_auth(parse_auth(out))
    except (json.JSONDecodeError, TypeError, AttributeError):
        return FAIL, f"auth status unreadable (exit {code})"


def check_env(env):
    present = sorted(name for name in FORBIDDEN_ENV if env.get(name))
    if present:
        return FAIL, "remove before running the app: " + ", ".join(present)
    return PASS, "no API-key/cloud-provider variables"


def collect(env=None, include_network=True):
    env = os.environ if env is None else env
    binary = find_claude()
    checks = [
        ("os", check_os),
        ("python", check_python),
        ("git_identity", check_git_identity),
        ("docker", check_docker),
        ("node", check_node),
        ("pnpm", check_pnpm),
        ("claude_cli", lambda: check_claude(binary)),
        ("claude_auth", lambda: check_auth(binary)),
        ("credential_env", lambda: check_env(env)),
    ]
    if include_network:
        checks.insert(3, ("git_remote", check_git_remote))
    results = []
    for key, fn in checks:
        status, detail = fn()
        results.append({"id": key, "status": status, "detail": detail})
    results += [{"id": key, "status": MANUAL_STATUS, "detail": text} for key, text in MANUAL]
    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--json", metavar="PATH", help="write evidence JSON (no secrets)")
    parser.add_argument("--offline", action="store_true", help="skip git remote check")
    args = parser.parse_args()
    results = collect(include_network=not args.offline)
    for item in results:
        print(f"{item['status']:<7} {item['id']:<15} {item['detail']}")
    failed = [r["id"] for r in results if r["status"] == FAIL]
    summary = {"toolchain": TOOLCHAIN, "results": results, "failed": failed}
    if args.json:
        out = pathlib.Path(args.json)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n")
    print(f"\n{'FAIL' if failed else 'PASS'}: {len(failed)} required check(s) failed;"
          f" {len(MANUAL)} manual item(s) deferred to feature WBS")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
