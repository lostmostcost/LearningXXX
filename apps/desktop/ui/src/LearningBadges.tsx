import { useCallback, useEffect, useRef, useState } from "react";
import type { CourseLearningStatus, LearningItem } from "@learningxxx/contracts";
import { invoke } from "./host-api.ts";
import { badges } from "./learning.ts";

export type ViewRecord = { state: "recording" } | { state: "failed"; message: string };

/**
 * The LMS learning status of one course (WBS-055). Read again when `stamp`
 * changes (e.g. after a collection) and on `reload(true)`. `recordView`
 * (WBS-056) lets the LMS record that a material was opened in the app; it
 * runs once per item unless the user retries.
 */
export function useLearningStatus(courseId: string | undefined, stamp?: unknown) {
  const [status, setStatus] = useState<CourseLearningStatus>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [views, setViews] = useState<Record<string, ViewRecord>>({});
  const current = useRef(courseId);
  current.current = courseId;
  const attempted = useRef(new Set<string>());
  // A late answer for a course the user already left is dropped.
  const accept = useCallback((next: CourseLearningStatus | undefined) => {
    setStatus((old) => (next && next.courseId === current.current ? next : old?.courseId === current.current ? old : undefined));
  }, []);
  const load = useCallback(async (refresh: boolean) => {
    if (!courseId) return setStatus(undefined);
    setLoading(true);
    const result = await invoke("learning.status", { courseId, refresh });
    setLoading(false);
    if (!result.ok) return setError(result.error.message);
    setError(result.data.status?.errors[0]?.message);
    accept(result.data.status);
  }, [courseId, accept]);
  useEffect(() => {
    setStatus(undefined);
    setError(undefined);
    setViews({});
    void load(false);
  }, [load, stamp]);
  const recordView = useCallback(async (moduleItemId: string, retry = false) => {
    if (!courseId) return;
    const key = `${courseId}:${moduleItemId}`;
    if (attempted.current.has(key) && !retry) return;
    attempted.current.add(key);
    setViews((v) => ({ ...v, [moduleItemId]: { state: "recording" } }));
    const result = await invoke("learning.recordView", { courseId, moduleItemId });
    if (current.current !== courseId) return;
    setViews((v) => {
      const next = { ...v };
      if (result.ok) delete next[moduleItemId];
      else next[moduleItemId] = { state: "failed", message: result.error.message };
      return next;
    });
    if (result.ok) accept(result.data.status);
  }, [courseId, accept]);
  return { status, loading, error, reload: load, views, recordView };
}

export function Badges({ item }: { item: LearningItem | undefined }) {
  if (!item) return null;
  return <>{badges(item).map((b) => <span key={b.text} className={`badge lms ${b.tone}`}>{b.text}</span>)}</>;
}

/** The view record of the material in the viewer: in progress, or failed with a retry. */
export function ViewRecordNote({ view, onRetry }: { view: ViewRecord | undefined; onRetry: () => void }) {
  if (!view) return null;
  if (view.state === "recording") return <span className="badge lms muted" role="status">LMS 열람 기록 중…</span>;
  return (
    <span className="view-record-failed" role="alert">
      <span className="badge lms warn" title={view.message}>LMS 열람 기록 실패</span>
      <button type="button" className="link" onClick={onRetry}>다시 시도</button>
    </span>
  );
}
