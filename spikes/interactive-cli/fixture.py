"""Non-network terminal fixture. Never imports or invokes Claude."""
import base64
import fcntl
import json
import os
import signal
import sys
import termios
import tty


def size(*_):
    rows, cols = __import__('struct').unpack('HHHH', fcntl.ioctl(0, termios.TIOCGWINSZ, b'\0' * 8))[:2]
    os.write(1, f'SIZE:{rows}:{cols}\r\n'.encode())


tty.setraw(0)
signal.signal(signal.SIGWINCH, size)
os.write(1, ('TTY:' + json.dumps([os.isatty(i) for i in range(3)]) + '\r\n').encode())
os.write(1, b'\x1b[1mNATIVE MENU\x1b[0m\r\n')
size()
while True:
    data = os.read(0, 65536)
    if b'\x04' in data:
        break
    os.write(1, b'INPUT:' + base64.b64encode(data) + b'\r\n')
