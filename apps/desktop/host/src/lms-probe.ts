import { writeFileSync } from "node:fs";
import { CollectionError, discoverCourse } from "@learningxxx/collector";
import { createLmsClient, openLoginWindow } from "./lms-session.ts";

/**
 * WBS-034 check, run with --lms-probe=<file>: does the collector work against
 * the real LMS? Records field names and outcomes in a local file. The user signs
 * in themselves; nothing here sees their credentials. Read-only.
 */
const COURSE = "95899";
const TIMEOUT_MS = 10 * 60 * 1000;

async function attempt() {
  const client = createLmsClient();
  try {
    const { course, weeks } = await discoverCourse({ client, accountKey: "acct_localprobe01", sourceCourseId: COURSE });
    return { ok: true as const, title: course.title, termId: course.termId, weekCount: weeks.length, labels: weeks.map((w) => w.label) };
  } catch (error) {
    if (error instanceof CollectionError) return { ok: false as const, code: error.appError.code, detail: error.appError.detail };
    return { ok: false as const, code: "UNEXPECTED", detail: { name: (error as Error).name } };
  }
}

async function shapes() {
  const client = createLmsClient();
  const course = (await client.getObject(`/api/v1/courses/${COURSE}`)) as object;
  const modules = await client.getList(`/api/v1/courses/${COURSE}/modules?per_page=100`);
  return { courseFields: Object.keys(course).sort(), moduleFields: Object.keys((modules[0] ?? {}) as object).sort() };
}

export async function runLmsProbe(out: string): Promise<void> {
  const report: Record<string, unknown> = { before: await attempt() };
  let result = report.before as Awaited<ReturnType<typeof attempt>>;

  if (!result.ok) {
    const window = openLoginWindow();
    await new Promise<void>((resolve) => {
      const finish = () => resolve();
      const timer = setTimeout(finish, TIMEOUT_MS);
      let checking = false;
      const check = async () => {
        if (checking) return;
        checking = true;
        result = await attempt();
        checking = false;
        if (result.ok) {
          clearTimeout(timer);
          finish();
        }
      };
      window.webContents.on("did-finish-load", () => void check());
      window.once("closed", () => {
        clearTimeout(timer);
        void attempt().then((last) => {
          result = last;
          finish();
        });
      });
    });
    if (!window.isDestroyed()) window.close();
    report.after = result;
  }
  if (result.ok) {
    report.shapes = await shapes().catch((error: Error) => ({ failed: error.name }));
  }
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
}
