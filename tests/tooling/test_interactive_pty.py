"""WBS-050: real PTY, synthetic child only; no Claude credentials/model requests."""
import base64
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('interactive_pty', ROOT / 'spikes/interactive-cli/pty_session.py')
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
PtySession = MODULE.PtySession


class InteractivePtyTests(unittest.TestCase):
    def start(self):
        folder = tempfile.TemporaryDirectory(prefix='learningxxx-pty-fixture-')
        self.addCleanup(folder.cleanup)
        terminal = PtySession([sys.executable, str(ROOT / 'spikes/interactive-cli/fixture.py')], folder.name, {'PATH': os.environ.get('PATH', ''), 'HOME': folder.name})
        self.addCleanup(terminal.close)
        return terminal

    def until(self, terminal, marker):
        output = b''
        deadline = time.monotonic() + 3
        while marker not in output and time.monotonic() < deadline:
            output += terminal.read(.05)
        self.assertIn(marker, output)
        return output

    def test_real_tty_and_ansi_are_preserved(self):
        output = self.until(self.start(), b'SIZE:')
        self.assertIn(b'TTY:[true, true, true]', output)
        self.assertIn(b'\x1b[1mNATIVE MENU\x1b[0m', output)

    def test_slash_unicode_paste_and_navigation_are_not_rewritten(self):
        terminal = self.start()
        self.until(terminal, b'SIZE:')
        for data in [b'/compact\t', b'/model\r', b'\x1b[A\x1b[B', '\x1b[200~논리회로\n질문\x1b[201~'.encode()]:
            terminal.write(data)
            self.until(terminal, b'INPUT:' + base64.b64encode(data))

    def test_resize_reaches_child_and_does_not_restart_it(self):
        terminal = self.start()
        self.until(terminal, b'SIZE:')
        pid = terminal.pid
        terminal.resize(40, 120)
        self.until(terminal, b'SIZE:40:120')
        self.assertEqual(terminal.pid, pid)

    def test_eof_and_close_are_reaped_and_idempotent(self):
        terminal = self.start()
        self.until(terminal, b'SIZE:')
        terminal.write(b'\x04')
        self.assertEqual(terminal.wait(), 0)
        terminal.close()
        terminal.close()
        with self.assertRaises(RuntimeError):
            terminal.write(b'/help')

    def test_abandoned_child_is_terminated(self):
        terminal = self.start()
        self.until(terminal, b'SIZE:')
        terminal.close()
        self.assertIsNotNone(terminal.status)
        with self.assertRaises(ProcessLookupError):
            os.kill(terminal.pid, 0)

    def test_dimensions_and_executable_are_validated_before_fork(self):
        for rows, cols in [(0, 80), (24, 0), (501, 80), (True, 80)]:
            with self.assertRaises(ValueError):
                PtySession([sys.executable], '.', {}, rows=rows, cols=cols)
        with self.assertRaises(ValueError):
            PtySession(['claude'], '.', {})
