"""Offline checks for the isolation verdict logic. Makes no CLI or network calls."""
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).parent))
import isolation  # noqa: E402


def call(**overrides):
    base = {"exit_code": 0, "is_error": False, "api_key_source": "none", "tools": ["Read"],
            "stream_canaries": [], "transcript_canaries": [], "hook_ran": False,
            "mcp_launched": False, "tool_attempts": ["read"], "mcp_tool_count": 0}
    return {**base, **overrides}


def scenario(**isolated_overrides):
    controls = {"root_context": call(stream_canaries=["PARENT", "HOOK", "MEMORY"],
                                     mcp_launched=True),
                "child_context": call(stream_canaries=["PARENT", "MEMORY"]),
                "history_seed": call(transcript_canaries=["HISTORY"])}
    isolated = {"root_context": call(), "child_context": call(),
                "outside_paths": call(), "symlink": call(), "symlink_search": call(),
                "attachment_symlink": call(stream_canaries=[]),
                "outside_write": call(outside_files_changed=False),
                "attachment": call(stream_canaries=["ATTACH"])}
    isolated.update(isolated_overrides)
    return controls, isolated


class Judge(unittest.TestCase):
    def test_clean_run_with_leaking_control_passes(self):
        self.assertEqual(isolation.judge(*scenario())[0], "PASS")

    def test_silent_control_voids_the_result(self):
        controls, isolated = scenario()
        controls["root_context"] = call()
        self.assertEqual(isolation.judge(controls, isolated)[0], "INCONCLUSIVE")

    def test_canary_in_transcript_fails(self):
        verdict = isolation.judge(*scenario(symlink=call(transcript_canaries=["COURSE"])))
        self.assertEqual(verdict[0], "FAIL")

    def test_hook_execution_fails_even_without_canary(self):
        verdict = isolation.judge(*scenario(child_context=call(hook_ran=True)))
        self.assertEqual(verdict[0], "FAIL")

    def test_unattempted_access_is_not_a_pass(self):
        verdict = isolation.judge(*scenario(outside_paths=call(tool_attempts=[])))
        self.assertEqual(verdict[0], "FAIL")

    def test_attachment_may_not_expose_other_canaries(self):
        leaked = call(stream_canaries=["ATTACH", "COURSE"])
        self.assertEqual(isolation.judge(*scenario(attachment=leaked))[0], "FAIL")

    def test_connector_tools_fail_even_without_canary(self):
        verdict = isolation.judge(*scenario(child_context=call(mcp_tool_count=3)))
        self.assertEqual(verdict[0], "FAIL")

    def test_symlink_escape_from_attachment_fails(self):
        leaked = call(stream_canaries=["COURSE"])
        verdict = isolation.judge(*scenario(attachment_symlink=leaked))
        self.assertEqual(verdict[0], "FAIL")

    def test_changed_outside_file_fails(self):
        verdict = isolation.judge(*scenario(outside_write=call(outside_files_changed=True)))
        self.assertEqual(verdict[0], "FAIL")

    def test_api_key_path_fails(self):
        verdict = isolation.judge(*scenario(child_context=call(api_key_source="env")))
        self.assertEqual(verdict[0], "FAIL")


class Helpers(unittest.TestCase):
    def test_project_slug_replaces_separators(self):
        self.assertEqual(isolation.project_slug("/tmp/a_b.c"), "-tmp-a-b-c")

    def test_sanitize_removes_user_and_slugs(self):
        root = pathlib.Path("/tmp/wbs")
        home = pathlib.Path.home()
        text = f"{isolation.project_slug(root)} {home.name} {home}/x"
        self.assertEqual(isolation.sanitize(text, root),
                         "<workspace-slug> <user> <home>/x")

    def test_find_canaries_needs_the_full_token(self):
        canaries = {"COURSE": "CANARY-COURSE-abc"}
        self.assertEqual(isolation.find_canaries("CANARY-COURSE-", canaries), [])
        self.assertEqual(isolation.find_canaries("x CANARY-COURSE-abc", canaries), ["COURSE"])


if __name__ == "__main__":
    unittest.main()
