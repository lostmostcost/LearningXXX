import type { ThemePreference } from "@learningxxx/contracts";

/** WBS-100: the host applies the theme to every window (Electron nativeTheme), so this query is the effective theme. */
export const DARK_QUERY = "(prefers-color-scheme: dark)";
/** Fired after any app preference is saved; screens that read preferences read them again. */
export const PREFERENCES_EVENT = "learningxxx:preferences";

export const THEME_LABELS: Record<ThemePreference, string> = { system: "시스템 설정 따르기", light: "라이트", dark: "다크" };

/** The one-click switch always picks the opposite of what is on screen now, as an explicit choice. */
export function toggledTheme(dark: boolean): ThemePreference { return dark ? "light" : "dark"; }

export function toggleLabel(dark: boolean): string { return dark ? "라이트 모드로 전환" : "다크 모드로 전환"; }
