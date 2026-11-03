import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { terminalInputChunks } from './terminal-input.ts';
import { invoke } from './host-api.ts';

/** Only terminal bytes cross IPC. The CLI owns slash menus, answers and permission dialogs. */
export function NativeTerminal({ appSessionId }: { appSessionId: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [notice, setNotice] = useState('연결 중…');
  const [retry, setRetry] = useState(0);
  const id = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!box.current) return;
    let alive = true, timer: ReturnType<typeof setTimeout> | undefined;
    let after = 0, input = Promise.resolve();
    id.current = undefined;
    setNotice('연결 중…');
    const term = new Terminal({ cursorBlink: true, convertEol: false, fontFamily: 'Menlo, monospace', fontSize: 12, scrollback: 3000, disableStdin: true, theme: { background: '#20211f', foreground: '#eeeef0', cursor: '#b6cbbd' } });
    const fit = new FitAddon(); term.loadAddon(fit); term.open(box.current);
    const dimensions = () => ({ cols: Math.max(2, Math.min(500, term.cols)), rows: Math.max(2, Math.min(500, term.rows)) });
    const resize = new ResizeObserver(() => {
      if (!alive || !box.current?.clientWidth || !box.current.clientHeight) return;
      fit.fit();
      if (id.current) void invoke('terminal.resize', { terminalId: id.current, ...dimensions() }).catch(() => undefined);
    }); resize.observe(box.current); fit.fit();
    const onData = term.onData(data => {
      const target = id.current;
      if (!target || !alive) return;
      // Preserve key ordering without letting a pasted block exceed the IPC bound.
      input = input.then(async () => {
        for (const part of terminalInputChunks(data)) {
          if (!alive) return;
          const result = await invoke('terminal.write', { terminalId: target, data: part });
          if (!result.ok) { setNotice(result.error.message); return; }
        }
      }).catch(() => { if (alive) setNotice('입력을 전달하지 못했습니다. 다시 연결하세요.'); });
    });
    const poll = async (terminalId: string) => {
      try {
        const result = await invoke('terminal.read', { terminalId, after });
        if (!alive) return;
        if (!result.ok) { setNotice(result.error.message); term.options.disableStdin = true; return; }
        if (result.data.gap) { term.reset(); term.writeln('[이전 화면 일부 생략 · Ctrl+L로 다시 그리기]'); }
        for (const chunk of result.data.chunks) {
          if (!alive) return;
          await new Promise<void>(resolve => term.write(chunk.data, resolve));
          after = chunk.seq;
        }
        if (!alive) return;
        if (result.data.state === 'exited') { term.options.disableStdin = true; setNotice(`Claude Code 종료${result.data.exitCode === undefined ? '' : ` (${result.data.exitCode})`}`); return; }
        timer = setTimeout(() => void poll(terminalId), 100);
      } catch { if (alive) setNotice('연결이 끊겼습니다. 다시 연결하세요.'); }
    };
    void invoke('terminal.open', { appSessionId, ...dimensions() }).then(result => {
      if (!alive) return;
      if (!result.ok) { setNotice(result.error.message); return; }
      id.current = result.data.terminalId; setNotice(''); term.options.disableStdin = false;
      term.focus(); void poll(result.data.terminalId);
    }).catch(() => { if (alive) setNotice('Claude Code를 연결하지 못했습니다.'); });
    return () => { alive = false; clearTimeout(timer); resize.disconnect(); onData.dispose(); term.dispose(); id.current = undefined; };
    // Changing visible session detaches its view; the host keeps that CLI alive.
  }, [appSessionId, retry]);
  return <div className="native-terminal"><div className="native-terminal-screen" ref={box} aria-label="Claude Code 대화형 터미널" />{notice ? <div className="terminal-notice" role="status">{notice}<button onClick={() => setRetry(n => n + 1)}>다시 연결</button></div> : null}<button className="terminal-stop" title="이 Claude Code 종료" aria-label="이 Claude Code 종료" onClick={async () => { if (id.current) await invoke('terminal.close', { terminalId: id.current }); }}>■</button></div>;
}
