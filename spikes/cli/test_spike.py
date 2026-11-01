"""Offline checks for the harness logic. Makes no CLI or network calls."""
import json
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).parent))
import spike  # noqa: E402


class ParseEvents(unittest.TestCase):
    def test_extracts_init_tools_and_result(self):
        lines = [
            {"type": "system", "subtype": "init", "apiKeySource": "none"},
            {"type": "assistant", "message": {"content": [
                {"type": "text", "text": "hi"},
                {"type": "tool_use", "name": "Write"}]}},
            {"type": "result", "result": "done", "is_error": False},
        ]
        parsed = spike.parse_events("\n".join(json.dumps(x) for x in lines))
        self.assertEqual(parsed["init"]["apiKeySource"], "none")
        self.assertEqual(parsed["tools"], ["Write"])
        self.assertEqual(parsed["result"]["result"], "done")

    def test_counts_non_json_lines_instead_of_crashing(self):
        parsed = spike.parse_events('not json\n{"type": "result"}\n')
        self.assertEqual(parsed["unparsed_lines"], 1)
        self.assertIsNotNone(parsed["result"])


class SubscriptionGuard(unittest.TestCase):
    def test_flags_each_auth_override(self):
        env = {"ANTHROPIC_API_KEY": "x", "CLAUDE_CODE_USE_BEDROCK": "1", "PATH": "/bin"}
        self.assertEqual(spike.find_forbidden_env(env),
                         ["ANTHROPIC_API_KEY", "CLAUDE_CODE_USE_BEDROCK"])

    def test_empty_value_is_not_an_override(self):
        self.assertEqual(spike.find_forbidden_env({"ANTHROPIC_API_KEY": ""}), [])

    def test_success_requires_no_api_key_source(self):
        call = {"exit_code": 0, "is_error": False, "api_key_source": "ANTHROPIC_API_KEY"}
        self.assertFalse(spike.succeeded(call))
        self.assertTrue(spike.succeeded({**call, "api_key_source": "none"}))


class Redaction(unittest.TestCase):
    def test_removes_workspace_and_home_paths(self):
        home = pathlib.Path.home()
        text = spike.redact(f"/tmp/ws/a.txt and {home}/secret", pathlib.Path("/tmp/ws"))
        self.assertEqual(text, "<workspace>/a.txt and <home>/secret")


if __name__ == "__main__":
    unittest.main()
