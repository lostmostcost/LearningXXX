import { useCallback, useEffect, useState } from 'react';
import type { ChatOutput } from '@learningxxx/contracts';
import { invoke } from './host-api.ts';
import { MarkdownAnswer } from './MarkdownAnswer.tsx';
import { outputSize, outputTime } from './files.ts';

/**
 * WBS-081: the files this conversation made — in its own folder or written
 * elsewhere by Claude Code's file tools — with a text view inside the app,
 * opening documents in their own app, and showing any of them in Finder.
 * Listed again whenever Claude finishes a turn.
 */
export function ChatOutputs({ appSessionId, busy, onClose }: { appSessionId: string; busy: boolean; onClose: () => void }) {
  const [files, setFiles] = useState<ChatOutput[]>();
  const [folder, setFolder] = useState('');
  const [error, setError] = useState('');
  const [viewing, setViewing] = useState<{ file: ChatOutput; text: string }>();
  const load = useCallback(async () => {
    const r = await invoke('chat.outputs', { appSessionId });
    if (r.ok) { setFiles(r.data.files); setFolder(r.data.folder); setError(''); } else setError(r.error.message);
  }, [appSessionId]);
  useEffect(() => { setViewing(undefined); if (!busy) void load(); }, [load, busy]);

  const view = async (file: ChatOutput) => {
    const r = await invoke('chat.readOutput', { appSessionId, id: file.id });
    if (r.ok) setViewing({ file, text: r.data.text }); else setError(r.error.message);
  };
  const show = async (file: ChatOutput, how: 'open' | 'reveal') => {
    const r = await invoke('chat.showOutput', { appSessionId, id: file.id, how });
    if (!r.ok) setError(r.error.message);
  };

  return <aside className="chat-outputs" aria-label="이 대화가 만든 파일">
    <div className="chat-outputs-head"><strong>만든 파일</strong><button onClick={() => void load()} title="새로 고침" aria-label="새로 고침">↻</button><button onClick={onClose} title="닫기" aria-label="만든 파일 닫기">×</button></div>
    {error ? <p className="chat-error" role="alert">{error}</p> : null}
    {viewing ? <div className="chat-output-view">
      <div className="chat-outputs-head"><button onClick={() => setViewing(undefined)}>‹ 목록</button><span>{viewing.file.name}</span>{viewing.file.openable ? <button onClick={() => void show(viewing.file, 'open')}>열기</button> : null}<button onClick={() => void show(viewing.file, 'reveal')}>Finder에서 보기</button></div>
      {/\.(md|markdown)$/i.test(viewing.file.name) ? <MarkdownAnswer text={viewing.text} /> : <pre>{viewing.text}</pre>}
    </div> : files === undefined ? <p className="meta" role="status">찾는 중…</p> : !files.length ? <p className="meta">아직 이 대화가 만든 파일이 없습니다. "notes.md로 저장해 줘"처럼 요청하면 여기에 나타납니다.</p> : <ul>
      {files.map(f => <li key={f.id}>
        <span className="chat-output-name" title={f.location}>{f.name}<small className="meta">{f.where === 'folder' ? (f.location === f.name ? '대화 폴더' : `대화 폴더 · ${f.location}`) : f.location} · {outputSize(f.bytes)} · {outputTime(f.modifiedAt)}</small></span>
        <span className="chat-output-actions">
          {f.kind === 'text' ? <button onClick={() => void view(f)}>보기</button> : null}
          {f.openable ? <button onClick={() => void show(f, 'open')}>열기</button> : null}
          <button onClick={() => void show(f, 'reveal')} title="Finder에서 보기">Finder</button>
        </span>
      </li>)}
    </ul>}
    {folder ? <p className="meta">대화 폴더: {folder}</p> : null}
  </aside>;
}
