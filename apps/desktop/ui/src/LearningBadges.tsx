import { useCallback, useEffect, useState } from "react";
import type { CourseLearningStatus, LearningItem } from "@learningxxx/contracts";
import { invoke } from "./host-api.ts";
import { badges } from "./learning.ts";

/**
 * The LMS learning status of one course (WBS-055). Read again when `stamp`
 * changes (e.g. after a collection) and on `reload(true)`.
 */
export function useLearningStatus(courseId: string | undefined, stamp?: unknown) {
  const [status, setStatus] = useState<CourseLearningStatus>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const load = useCallback(async (refresh: boolean) => {
    if (!courseId) return setStatus(undefined);
    setLoading(true);
    const result = await invoke("learning.status", { courseId, refresh });
    setLoading(false);
    if (!result.ok) return setError(result.error.message);
    setError(result.data.status?.errors[0]?.message);
    // A late answer for a course the user already left is dropped.
    setStatus((current) => (result.data.status?.courseId === courseId ? result.data.status : current?.courseId === courseId ? current : undefined));
  }, [courseId]);
  useEffect(() => {
    setStatus(undefined);
    setError(undefined);
    void load(false);
  }, [load, stamp]);
  return { status, loading, error, reload: load };
}

export function Badges({ item }: { item: LearningItem | undefined }) {
  if (!item) return null;
  return <>{badges(item).map((b) => <span key={b.text} className={`badge lms ${b.tone}`}>{b.text}</span>)}</>;
}
