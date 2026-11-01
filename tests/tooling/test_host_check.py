"""Host checklist logic that does not depend on the machine it runs on."""
import importlib.util
import json
import pathlib
import unittest

module_path = pathlib.Path(__file__).resolve().parents[2] / "scripts/host_check.py"
spec = importlib.util.spec_from_file_location("host_check", module_path)
host_check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host_check)


class HostCheckTests(unittest.TestCase):
    def test_forbidden_env_fails_and_names_variable(self):
        status, detail = host_check.check_env({"ANTHROPIC_API_KEY": "sk-secret-value"})
        self.assertEqual(host_check.FAIL, status)
        self.assertIn("ANTHROPIC_API_KEY", detail)
        self.assertNotIn("sk-secret-value", detail)

    def test_empty_forbidden_env_value_is_ignored(self):
        status, _ = host_check.check_env({"ANTHROPIC_API_KEY": ""})
        self.assertEqual(host_check.PASS, status)

    def test_auth_fields_are_allowlisted(self):
        raw = json.dumps({"loggedIn": True, "authMethod": "claude.ai",
                          "subscriptionType": "pro", "email": "a@b.c", "orgName": "o"})
        auth = host_check.parse_auth(raw)
        self.assertNotIn("email", auth)
        self.assertNotIn("orgName", auth)
        self.assertEqual(host_check.PASS, host_check.judge_auth(auth)[0])

    def test_api_key_login_is_rejected(self):
        auth = {"loggedIn": True, "authMethod": "api_key"}
        self.assertEqual(host_check.FAIL, host_check.judge_auth(auth)[0])
        self.assertEqual(host_check.FAIL, host_check.judge_auth({"loggedIn": False})[0])

    def test_version_pin_comparison(self):
        self.assertEqual(host_check.PASS, host_check.compare_pin("node", "v24.22.2", "24.22.2")[0])
        self.assertEqual(host_check.WARN, host_check.compare_pin("node", "v24.1.0", "24.22.2")[0])
        self.assertEqual(host_check.FAIL, host_check.compare_pin("node", "v22.23.4", "24.22.2")[0])
        self.assertEqual(host_check.FAIL, host_check.compare_pin("node", "", "24.22.2")[0])

    def test_manual_items_are_never_reported_as_pass(self):
        manual = [key for key, _ in host_check.MANUAL]
        self.assertIn("microphone", manual)
        self.assertIn("keychain", manual)


if __name__ == "__main__":
    unittest.main()
