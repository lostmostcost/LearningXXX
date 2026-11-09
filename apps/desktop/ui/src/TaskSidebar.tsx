import type { CourseLearningStatus, LearningItem } from "@learningxxx/contracts";
import { Badges } from "./LearningBadges.tsx";
import { formatSeoul, type Entry, type Library } from "./library.ts";
import { tasksByWeek, type TaskRow } from "./tasks.ts";
import { itemForResource } from "./learning.ts";
import { useHiddenTodos } from "./hidden-todos.ts";

/**
 * WBS-075: the 과제 section by week. Every week starts closed; its heading
 * says how many are still to do and how many are submitted. Inside, to-do
 * items come first, then work not open yet, submitted ones, and items the
 * student took off the list (WBS-084).
 */
export function TaskSidebar({ library, status, currentWeekId, selectedId, onSelect, onOpenQuiz }: { library: Library; status: CourseLearningStatus | undefined; /** WBS-105: the week open by default (this week). */ currentWeekId?: string | undefined; selectedId: string | undefined; onSelect: (entry: Entry) => void; onOpenQuiz: (item: LearningItem) => void }) {
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
      <details key={w.key} className={`task-week${w.key === currentWeekId ? " is-current" : ""}`} open={w.key === currentWeekId || undefined}>
        <summary><strong>{w.label}</strong> <span className={w.todo.length ? "todo-count" : "meta"}>해야 함 {w.todo.length}</span> <span className="meta">· 제출 {w.done.length}{w.later.length ? ` · 열리기 전 ${w.later.length}` : ""}</span></summary>
        {w.todo.length ? <><p className="task-group">해야 할 과제</p><ul>{w.todo.map((r) => row(r))}</ul></> : null}
        {w.later.length ? <><p className="task-group">열리기 전</p><ul>{w.later.map((r) => row(r, "later"))}</ul></> : null}
        {w.done.length ? <><p className="task-group">제출한 과제</p><ul>{w.done.map((r) => row(r, "done"))}</ul></> : null}
        {w.hidden.length ? <><p className="task-group">목록에서 뺀 과제</p><ul>{w.hidden.map((r) => row(r, "hidden"))}</ul></> : null}
      </details>
    ))}
  </div>;
}

/**
 * WBS-106: while nothing is open, the middle column lists one week's
 * materials and notices, then its assignments and quizzes (the week chosen
 * in the week menu, which opens on this week). Choosing one opens it right
 * there, as from the side lists. Assignments taken off the list are counted,
 * not shown.
 */
export function WeekTasks({ library, status, weekId, onSelect, onOpenQuiz }: { library: Library; status: CourseLearningStatus | undefined; weekId: string | undefined; onSelect: (entry: Entry) => void; onOpenQuiz: (item: LearningItem) => void }) {
  const account = library.course.accountKey;
  const hidden = useHiddenTodos([account]);
  const week = library.weeks.find((w) => w.week.id === weekId)?.week;
  if (!week) return null;
  const group = tasksByWeek(library, status, new Date(), (key) => hidden.isHidden(account, key)).find((w) => w.key === week.id);
  const rows: (readonly [TaskRow, "todo" | "later" | "done"])[] = group ? [...group.todo.map((r) => [r, "todo"] as const), ...group.later.map((r) => [r, "later"] as const), ...group.done.map((r) => [r, "done"] as const)] : [];
  const materials = (library.weeks.find((w) => w.week.id === week.id)?.entries ?? []).filter((e) => e.resource.kind !== "assignment");
  return <section className="week-tasks" aria-label={`${week.label} 자료와 과제`}>
    <h3>{week.label} 자료</h3>
    {materials.length ? <ul>{materials.map((e) => (
      <li key={e.resource.id} className="week-task">
        <button className="week-task-open" onClick={() => onSelect(e)}><strong>{e.resource.kind === "notice" ? "[공지] " : ""}{e.resource.title}</strong>
          <small>{e.resource.source === "manual" ? "직접 추가한 자료" : "LMS 자료"}{e.assets.length > 1 ? ` · 파일 ${e.assets.length}개` : ""}</small></button>
        <Badges item={itemForResource(status, e.resource)} />
      </li>))}</ul> : <p className="meta">이 주차에는 아직 자료가 없습니다.</p>}
    <h3>{week.label} 과제</h3>
    {rows.length ? <ul>{rows.map(([r, place]) => (
      <li key={r.key} className={`week-task ${place === "done" ? "is-done" : "is-todo"}`}>
        {r.entry ? <button className="week-task-open" onClick={() => onSelect(r.entry!)}><strong>{r.kind === "quiz" ? "[퀴즈] " : ""}{r.title}</strong>
          <small>{place === "later" && r.opensAt ? `${formatSeoul(r.opensAt)}부터 · ` : ""}{r.dueAt ? `마감 ${formatSeoul(r.dueAt)}` : "마감 정보 없음"}</small></button>
          : <span className="week-task-open"><strong>{r.kind === "quiz" ? "[퀴즈] " : ""}{r.title}</strong><small>{r.dueAt ? `마감 ${formatSeoul(r.dueAt)}` : "마감 정보 없음"} · LMS에만 있는 항목</small></span>}
        <Badges item={r.item} />
        {place === "todo" && r.kind === "quiz" && r.item && !r.item.quiz?.lockdownBrowser && (r.item.moduleItemId || r.item.quiz?.quizId) ? <button className="link-button" onClick={() => onOpenQuiz(r.item!)}>응시 창 열기</button> : null}
      </li>))}</ul> : <p className="meta">이 주차에는 과제가 없습니다.</p>}
    {group?.hidden.length ? <p className="meta">목록에서 뺀 과제 {group.hidden.length}개는 과제 탭에서 볼 수 있습니다.</p> : null}
  </section>;
}
