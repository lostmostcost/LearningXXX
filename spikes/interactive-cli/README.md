# Interactive transport spike · WBS-050

`pty_session.py` proves standard PTY properties with `fixture.py`, which never invokes Claude, reads an account, or accesses network/files outside its disposable working directory. This Python code is verification only; the product uses node-pty and xterm.js.

```sh
python3 -m unittest discover -s tests/tooling -p test_interactive_pty.py -v
```

Real-account tests were separately authorized by the owner for WBS-050. See apps/desktop/host/NATIVE-TERMINAL.md for actual evidence and limitations. Do not equate a fixture's command echo with vendor-command support or the previous independent-session isolation proof.
