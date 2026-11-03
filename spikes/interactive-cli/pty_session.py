"""WBS-050 transport spike. Standard-library PTY; never launches Claude implicitly.

This is a verification harness, not a new Python dependency of the product.
No parsing/replacement of slash commands or ANSI sequences occurs here.
"""
import errno
import fcntl
import os
import pty
import select
import signal
import struct
import termios
import time


class PtySession:
    def __init__(self, argv, cwd, env, rows=24, cols=80):
        if not argv or not os.path.isabs(argv[0]):
            raise ValueError('Executable must be an absolute path')
        self.pid = None
        self.fd = None
        self.status = None
        self._size(rows, cols)
        pid, fd = pty.fork()
        if pid == 0:
            try:
                os.chdir(cwd)
                os.execve(argv[0], argv, dict(env, TERM='xterm-256color'))
            except BaseException:
                os.write(2, b'PTY child could not start\r\n')
                os._exit(127)
        self.pid, self.fd = pid, fd
        try:
            os.set_blocking(fd, False)
            self.resize(rows, cols)
        except BaseException:
            self.close()
            raise

    @staticmethod
    def _size(rows, cols):
        if type(rows) is not int or type(cols) is not int or not (2 <= rows <= 500 and 2 <= cols <= 500):
            raise ValueError('Invalid terminal dimensions')

    def resize(self, rows, cols):
        self._size(rows, cols)
        if self.fd is None:
            raise RuntimeError('Terminal is closed')
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))

    def read(self, timeout=.1):
        if self.fd is None:
            return b''
        if not select.select([self.fd], [], [], timeout)[0]:
            return b''
        try:
            return os.read(self.fd, 65536)
        except OSError as exc:
            if exc.errno in (errno.EIO, errno.EBADF):
                return b''  # macOS/Linux PTY EOF
            raise

    def write(self, data, timeout=2):
        if self.fd is None:
            raise RuntimeError('Terminal is closed')
        pending = memoryview(data)
        deadline = time.monotonic() + timeout
        while pending:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not select.select([], [self.fd], [], remaining)[1]:
                raise TimeoutError('Terminal input is blocked')
            try:
                count = os.write(self.fd, pending)
                pending = pending[count:]
            except BlockingIOError:
                continue

    def wait(self, timeout=2):
        if self.pid is None or self.status is not None:
            return self.status
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            pid, status = os.waitpid(self.pid, os.WNOHANG)
            if pid:
                self.status = os.waitstatus_to_exitcode(status)
                return self.status
            time.sleep(.01)
        return None

    def close(self):
        # Closing a pane must not leave a billable agent/process group running.
        if self.pid is not None:
            try:
                os.killpg(self.pid, signal.SIGTERM)
            except PermissionError:
                try:
                    os.kill(self.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
            except ProcessLookupError:
                pass
            if self.wait(.5) is None:
                try:
                    os.killpg(self.pid, signal.SIGKILL)
                except PermissionError:
                    try:
                        os.kill(self.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                except ProcessLookupError:
                    pass
                self.wait(1)
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()
