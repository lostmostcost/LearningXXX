import { useCallback, useEffect, useState } from "react";
import type { LearningItem } from "@learningxxx/contracts";

/**
 * WBS-084: to-do items the student took off the list (does not apply, or
 * past and no longer wanted). Kept on this Mac per school account, like 나의
 * 할 일; the LMS is never told anything, and every item can be put back.
 */

const EVENT = "learningxxx:hidden-todos";
const storageKey = (accountKey: string) => `learningxxx.hiddenTodos:${accountKey}`;

/** An LMS item of a course. */
export const itemKey = (courseId: string, item: Pick<LearningItem, "moduleItemId" | "sourceRef" | "title">) => `${courseId}:${item.moduleItemId ?? item.sourceRef ?? item.title}`;
/** A collected assignment without an LMS item. */
export const resourceKey = (courseId: string, resourceId: string) => `${courseId}:res:${resourceId}`;

export function readHidden(storage: Pick<Storage, "getItem">, accountKey: string): Set<string> {
  try {
    const value: unknown = JSON.parse(storage.getItem(storageKey(accountKey)) ?? "[]");
    return new Set(Array.isArray(value) ? value.filter((x): x is string => typeof x === "string" && x.length <= 600) : []);
  } catch { return new Set(); }
}

export function writeHidden(storage: Pick<Storage, "setItem">, accountKey: string, keys: ReadonlySet<string>): boolean {
  try { storage.setItem(storageKey(accountKey), JSON.stringify([...keys].slice(-2000))); return true; } catch { return false; }
}

/** The hidden keys of these accounts, kept in step across the app's views. */
export function useHiddenTodos(accountKeys: readonly string[]) {
  const scope = [...new Set(accountKeys)].sort().join("|");
  const read = useCallback(() => new Map(scope.split("|").filter(Boolean).map((a) => [a, readHidden(window.localStorage, a)] as const)), [scope]);
  const [hidden, setHidden] = useState(read);
  const [error, setError] = useState("");
  useEffect(() => {
    setHidden(read());
    const sync = () => setHidden(read());
    window.addEventListener(EVENT, sync);
    return () => window.removeEventListener(EVENT, sync);
  }, [read]);
  const isHidden = useCallback((accountKey: string, key: string) => hidden.get(accountKey)?.has(key) ?? false, [hidden]);
  const toggle = useCallback((accountKey: string, key: string) => {
    const next = new Set(readHidden(window.localStorage, accountKey));
    if (next.has(key)) next.delete(key); else next.add(key);
    setError(writeHidden(window.localStorage, accountKey, next) ? "" : "이 기기에 저장하지 못했습니다.");
    window.dispatchEvent(new Event(EVENT));
  }, []);
  return { isHidden, toggle, error };
}
