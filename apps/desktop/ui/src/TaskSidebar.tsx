import type { CourseLearningStatus, LearningItem } from "@learningxxx/contracts";
import { Badges } from "./LearningBadges.tsx";
import { formatSeoul, type Entry, type Library } from "./library.ts";
import { tasksByWeek, type TaskRow } from "./tasks.ts";
import { useHiddenTodos } from "./hidden-todos.ts";

/**
 * WBS-075: the 과제 section by week. Every week starts closed; its heading
 * says how many are still to do and how many are submitted. Inside, to-do
 * items come first, then work not open yet, submitted ones, and items the
 * student took off the list (WBS-084).
 */
export function TaskSidebar({ library, status, selectedId, onSelect, onOpenQuiz }: { library: Library; status: CourseLearningStatus | undefined; selectedId: string | undefined; onSelect: (entry: Entry) => void; onOpenQuiz: (item: LearningItem) => void }) {
  // WBS-084: items taken off the list (this Mac only) and work not open yet are shown apart.
  const account = library.course.accountKey;
  const hidden = useHiddenTodos([account]);
  const weeks = tasksByWeek(library, status, new Date(), (key) => hidden.isHidden(account, key));
  if (!weeks.length) return <p className="meta">과제가 없습니다.</p>;
  const row = (r: TaskRow, place: "todo" | "later" | "hidden" | "done" = "todo") => (
    <li key={r.key} className={`task-row ${r.done ? "is-done" : "is-todo"}`}>
      {r.entry ? <button className="task-open" aria-pressed={selectedId === r.entry.resource.id} onClick={() => onSelect(r.entry!)}>{r.kind === "quiz" ? "[퀴즈] " : ""}{r.title}</button> : <span className="task-title">{r.kind === "quiz" ? "[퀴즈] " : ""}{r.title}</span>}
      <small>{place === "later" && r.opensAt ? `${formatSeoul(r.opensAt)}부터 · ` : ""}{r.dueAt ? `마감 ${formatSeoul(r.dueAt)}` : "마감 정보 없음"}{r.done === undefined ? " · LMS 상태 확인 전" : ""} <Badges item={r.item} /></small>
      {place === "todo" || place === "later" ? <button className="link-button" title="목록에서 빼기(해당 없음·지난 과제) · LMS에는 영향 없음" onClick={() => hidden.toggle(account, r.hideKey)}>빼기</button> : place === "hidden" ? <button className="link-button" onClick={() => hidden.toggle(account, r.hideKey)}>되돌리기</button> : null}
      {place === "todo" && r.kind === "quiz" && r.item && !r.done && !r.item.quiz?.lockdownBrowser && (r.item.moduleItemId || r.item.quiz?.quizId) ? <button className="link-button" onClick={() => onOpenQuiz(r.item!)}>응시 창 열기</button> : null}
    </li>
  );
  return <div className="task-weeks">
    {weeks.map((w) => (
      <details key={w.key} className="task-week">
        <summary><strong>{w.label}</strong> <span className={w.todo.length ? "todo-count" : "meta"}>해야 함 {w.todo.length}</span> <span className="meta">· 제출 {w.done.length}{w.later.length ? ` · 열리기 전 ${w.later.length}` : ""}</span></summary>
        {w.todo.length ? <><p className="task-group">해야 할 과제</p><ul>{w.todo.map((r) => row(r))}</ul></> : null}
        {w.later.length ? <><p className="task-group">열리기 전</p><ul>{w.later.map((r) => row(r, "later"))}</ul></> : null}
        {w.done.length ? <><p className="task-group">제출한 과제</p><ul>{w.done.map((r) => row(r, "done"))}</ul></> : null}
        {w.hidden.length ? <><p className="task-group">목록에서 뺀 과제</p><ul>{w.hidden.map((r) => row(r, "hidden"))}</ul></> : null}
      </details>
    ))}
  </div>;
}
