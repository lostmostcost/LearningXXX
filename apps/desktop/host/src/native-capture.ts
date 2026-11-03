import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { AppError } from "@learningxxx/contracts";
import { MAX_ATTACHMENT_BYTES } from "./attachment-service.ts";

export const CAPTURE_ARGS = ["-i", "-s", "-t", "png", "-x"] as const;
export interface NativeCaptureOptions {
  permission: () => string;
  /**
   * WBS-080: asks macOS for screen recording access from the app itself, which
   * shows the system prompt and adds the app to the Screen Recording list.
   * `screencapture` alone never does, so the app could not be found in Settings.
   */
  requestAccess?: () => Promise<void>;
  platform?: string;
  /** Injectable in tests; output is always a host-generated disposable path. */
  run?: (output: string) => Promise<void>;
  tempRoot?: string;
}
function fail(code: "CAPTURE_PERMISSION_DENIED" | "CAPTURE_FAILED", message: string): never {
  throw Object.assign(new Error(message), { appError: AppError.parse({ code, message, retryable: code === "CAPTURE_FAILED" }) });
}
const permissionError = () => fail("CAPTURE_PERMISSION_DENIED", "화면 캡처에는 macOS 화면 기록 권한이 필요합니다. 아래 \"시스템 설정 열기\"를 눌러 \"화면 및 시스템 오디오 녹음\" 목록에서 이 앱(개발 실행은 \"Electron\")을 켠 뒤, 앱을 종료하고 다시 실행하세요.");
export function validateCapture(bytes: Uint8Array): void {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 33 || bytes.length > MAX_ATTACHMENT_BYTES || !signature.every((b, i) => bytes[i] === b) || String.fromCharCode(...bytes.slice(12, 16)) !== "IHDR") {
    fail("CAPTURE_FAILED", "캡처 이미지를 읽지 못했습니다. 영역을 다시 선택하세요.");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16), height = view.getUint32(20);
  if (!width || !height || width * height > 64_000_000) fail("CAPTURE_FAILED", "캡처 영역이 너무 크거나 올바르지 않습니다. 작은 영역을 다시 선택하세요.");
}

/** A user-triggered rectangle selection. Never captures the whole screen automatically. */
export async function captureRegion(options: NativeCaptureOptions): Promise<Uint8Array | undefined> {
  if ((options.platform ?? process.platform) !== "darwin") fail("CAPTURE_FAILED", "화면 캡처는 macOS 앱에서 사용할 수 있습니다.");
  // WBS-080: not decided yet (or never asked by this app): ask once, so macOS shows its prompt and lists the app.
  if (options.permission() !== "granted" && options.requestAccess) await options.requestAccess().catch(() => undefined);
  if (["denied", "restricted", "not-determined"].includes(options.permission())) permissionError();
  const dir = await mkdtemp(join(options.tempRoot ?? tmpdir(), "learningxxx-capture-"));
  await chmod(dir, 0o700);
  const output = join(dir, "selection.png");
  try {
    let cancelled = false;
    try {
      if (options.run) await options.run(output);
      else await promisify(execFile)("/usr/sbin/screencapture", [...CAPTURE_ARGS, output], { timeout: 120_000, maxBuffer: 1024 * 1024 });
    } catch (error) {
      if (options.permission() !== "granted") permissionError();
      if ((error as { code?: unknown }).code === 1) cancelled = true;
      else fail("CAPTURE_FAILED", "캡처를 완료하지 못했습니다. 다시 시도하세요.");
    }
    // Escape may exit 0 or 1 without creating a file; a partial cancelled output is never used.
    const info = await stat(output).catch(() => undefined);
    if (cancelled || !info) {
      if (options.permission() !== "granted") permissionError();
      return undefined;
    }
    if (options.permission() !== "granted") permissionError();
    if (info.size > MAX_ATTACHMENT_BYTES) fail("CAPTURE_FAILED", "캡처는 20MB까지 지원합니다. 작은 영역을 선택하세요.");
    const bytes = new Uint8Array(await readFile(output));
    validateCapture(bytes);
    return bytes;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
