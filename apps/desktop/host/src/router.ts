import { IpcChannels, IpcEnvelope, SCHEMA_VERSION } from "@learningxxx/contracts";
import type { AppError, ErrorCode, IpcChannel, IpcRequest, IpcResponse, IpcResult } from "@learningxxx/contracts";

export type Handlers = {
  [C in IpcChannel]?: (request: IpcRequest<C>) => Promise<IpcResponse<C>>;
};

const failure = (code: ErrorCode, message: string): IpcResult<never> => ({
  ok: false,
  error: { code, message, retryable: false },
});

/**
 * The only path from the renderer into the host. Every request is validated
 * here even when the renderer already checked it, because the renderer is not
 * a security boundary (ADR-002). Internal error text never reaches the renderer.
 */
export function createRouter(handlers: Handlers) {
  return async function handle(raw: unknown): Promise<IpcResult<unknown>> {
    const envelope = IpcEnvelope.safeParse(raw);
    if (!envelope.success) {
      const version = (raw as { schemaVersion?: unknown } | null)?.schemaVersion;
      if (typeof version === "number" && version !== SCHEMA_VERSION) {
        return failure("SCHEMA_VERSION_UNSUPPORTED", "앱 업데이트가 필요합니다.");
      }
      return failure("INVALID_REQUEST", "잘못된 요청입니다.");
    }
    const { channel, payload } = envelope.data;
    const contract = IpcChannels[channel];
    const request = contract.request.safeParse(payload);
    if (!request.success) return failure("INVALID_REQUEST", "잘못된 요청입니다.");

    const handler = handlers[channel] as ((request: unknown) => Promise<unknown>) | undefined;
    if (handler === undefined) return failure("INTERNAL", "아직 구현되지 않은 기능입니다.");
    try {
      const data = contract.response.parse(await handler(request.data));
      return { ok: true, data };
    } catch (error) {
      const appError = (error as { appError?: AppError }).appError;
      return appError ? { ok: false, error: appError } : failure("INTERNAL", "내부 오류가 발생했습니다.");
    }
  };
}
