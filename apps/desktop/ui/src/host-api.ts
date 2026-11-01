import type { IpcChannel, IpcRequest, IpcResponse, IpcResult } from "@learningxxx/contracts";

declare global {
  interface Window {
    host?: { invoke(channel: string, payload: unknown): Promise<unknown> };
  }
}

/** Typed call into the host. This is the renderer's only way out of the sandbox. */
export async function invoke<C extends IpcChannel>(channel: C, payload: IpcRequest<C>): Promise<IpcResult<IpcResponse<C>>> {
  if (window.host === undefined) {
    return { ok: false, error: { code: "INTERNAL", message: "앱 안에서 실행해 주세요.", retryable: false } };
  }
  return (await window.host.invoke(channel, payload)) as IpcResult<IpcResponse<C>>;
}
