import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BrowserWindow } from "electron";

/**
 * Self-check for the real window, run with --ui-smoke=<dir>. It exercises what
 * unit tests cannot: the bundle loading under the CSP, the sandbox, F6 focus
 * movement and the narrow layout. Writes a report and screenshots to <dir>.
 */
const STATE = `(() => ({
  status: document.querySelector('[role="status"]')?.textContent ?? null,
  panels: [...document.querySelectorAll('section.panel')].map((p) => p.getAttribute('aria-label')),
  focused: document.activeElement?.getAttribute('aria-label') ?? null,
  tabs: document.querySelectorAll('[role="tab"]').length,
  overflowX: document.documentElement.scrollWidth > window.innerWidth,
  hasBridge: typeof window.host?.invoke === 'function',
  bridgeKeys: window.host ? Object.keys(window.host) : [],
  hasNode: typeof require !== 'undefined' || typeof process !== 'undefined',
}))()`;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runUiSmoke(window: BrowserWindow, dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  const { webContents } = window;
  const problems: string[] = [];
  webContents.on("console-message", (details) => {
    if (details.level === "warning" || details.level === "error") problems.push(details.message.slice(0, 200));
  });
  webContents.on("render-process-gone", (_event, details) => problems.push(`renderer gone: ${details.reason}`));
  webContents.on("did-fail-load", (_event, code, description) => problems.push(`load failed ${code}: ${description}`));

  const state = () => webContents.executeJavaScript(STATE) as Promise<Record<string, unknown>>;
  const shot = async (name: string) => writeFileSync(join(dir, name), (await webContents.capturePage()).toPNG());
  const pressF6 = async (shift = false) => {
    const modifiers: "shift"[] = shift ? ["shift"] : [];
    webContents.sendInputEvent({ type: "keyDown", keyCode: "F6", modifiers });
    webContents.sendInputEvent({ type: "keyUp", keyCode: "F6", modifiers });
    await wait(150);
  };
  if (webContents.isLoading()) await new Promise((resolve) => webContents.once("did-finish-load", () => resolve(undefined)));
  await wait(800);
  webContents.focus();

  const report: Record<string, unknown> = { wide: await state() };
  await shot("wide.png");
  const focus: unknown[] = [];
  for (let i = 0; i < 4; i += 1) {
    await pressF6();
    focus.push((await state()).focused);
  }
  await pressF6(true);
  report.f6 = focus;
  report.shiftF6 = (await state()).focused;

  window.setSize(700, 600);
  await wait(500);
  report.narrow = await state();
  await shot("narrow.png");
  await webContents.executeJavaScript(`document.querySelectorAll('[role="tab"]')[1]?.click()`);
  await wait(300);
  report.narrowChat = await state();
  await shot("narrow-chat.png");
  window.setSize(1280, 800);
  await wait(500);
  report.wideAgain = await state();
  report.problems = problems;
  writeFileSync(join(dir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
}

/** Clicks the first enabled button with this label; reports whether it existed. */
const click = (label: string) =>
  `(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent === ${JSON.stringify(label)} && !x.disabled); b?.click(); return !!b; })()`;

/**
 * The file panel in a real window, against the synthetic host. The window has
 * no preload on purpose: `?fixture` installs its stand-in only when no real host
 * exists, so no real file, dialog or CLI is reached. Run with --files-smoke=<dir>.
 */
export async function runFilesSmoke(uiEntry: string, dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  const window = new BrowserWindow({ width: 1280, height: 800, show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  const { webContents } = window;
  const problems: string[] = [];
  webContents.on("console-message", (details) => {
    if (details.level === "warning" || details.level === "error") problems.push(details.message.slice(0, 200));
  });
  await window.loadFile(uiEntry, { search: "fixture" });
  await wait(1200);
  const run = async (code: string) => {
    const value: unknown = await webContents.executeJavaScript(code);
    await wait(250);
    return value;
  };
  const text = () => webContents.executeJavaScript(`document.querySelector('section.files')?.innerText ?? null`) as Promise<string | null>;
  const report: Record<string, unknown> = {};
  report.createCourse = await run(click("과목 세션 만들기"));
  report.courseSection = await text();
  report.addFolder = await run(click("외부 폴더 추가"));
  report.afterFolder = await text();
  writeFileSync(join(dir, "files.png"), (await webContents.capturePage()).toPNG());
  report.askRestore = await run(click("이 실행 전으로 되돌리기"));
  report.restoreIsTwoStep = await text();
  report.confirmRestore = await run(click("되돌리기 확인"));
  report.afterRestore = await text();
  report.trash = await run(click("휴지통으로"));
  report.afterTrash = await text();
  report.createIndependent = await run(click("독립 세션 만들기"));
  report.independentSection = await text();
  report.problems = problems;
  writeFileSync(join(dir, "files-report.json"), `${JSON.stringify(report, null, 2)}\n`);
}
