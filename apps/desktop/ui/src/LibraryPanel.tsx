import type { Entry, Library } from "./library.ts";
import { deadline } from "./library.ts";

const KIND_LABEL = { file: "자료", notice: "공지", assignment: "과제" } as const;

function Row({ entry, selected, onSelect, now }: { entry: Entry; selected: boolean; onSelect: (e: Entry) => void; now: Date }) {
  const due = entry.assignment ? deadline(entry.assignment, now) : undefined;
  return (
    <li>
      <button
        className={`entry ${entry.resource.kind}`}
        aria-pressed={selected}
        aria-label={[KIND_LABEL[entry.resource.kind], entry.resource.title, entry.resource.source === "manual" ? "직접 추가" : "", due?.text ?? ""].filter(Boolean).join(", ")}
        onClick={() => onSelect(entry)}
      >
        <span className="kind">{KIND_LABEL[entry.resource.kind]}</span>
        <span className="title">{entry.resource.title}</span>
        {entry.resource.source === "manual" ? <span className="badge">직접 추가</span> : null}
        {due ? <span className={`badge due ${due.status}`}>{due.text}</span> : null}
      </button>
    </li>
  );
}

export function LibraryPanel(props: { library: Library; selectedId: string | undefined; onSelect: (e: Entry) => void; now: Date }) {
  const { library, selectedId } = props;
  const rows = (entries: Entry[]) => (
    <ul className="entries">
      {entries.map((e) => (
        <Row key={e.resource.id} entry={e} selected={e.resource.id === selectedId} onSelect={props.onSelect} now={props.now} />
      ))}
    </ul>
  );
  return (
    <>
      <h2>{library.course.title}</h2>
      {library.notices.length ? (
        <details open>
          <summary>과목 공지</summary>
          {rows(library.notices)}
        </details>
      ) : null}
      {library.weeks.map(({ week, entries }) => (
        <details key={week.id} open>
          <summary>{week.label}</summary>
          {entries.length ? rows(entries) : <p className="empty">이 주차에는 자료가 없습니다.</p>}
        </details>
      ))}
      {library.other.length ? (
        <details open>
          <summary>주차 없는 자료</summary>
          {rows(library.other)}
        </details>
      ) : null}
    </>
  );
}
