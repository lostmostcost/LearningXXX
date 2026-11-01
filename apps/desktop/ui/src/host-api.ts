import { HostPush } from "@learningxxx/contracts";
import type { IpcChannel, IpcRequest, IpcResponse, IpcResult } from "@learningxxx/contracts";

declare global {
  interface Window {
    host?: {
      invoke(channel: string, payload: unknown): Promise<unknown>;
      onPush?(listener: (message: unknown) => void): () => void;
    };
  }
}

/** Host → renderer messages, checked against the contract before use. Returns an unsubscribe. */
export function onHostPush(listener: (push: HostPush) => void): () => void {
  if (window.host?.onPush === undefined) return () => {};
  return window.host.onPush((message) => {
    const parsed = HostPush.safeParse(message);
    if (parsed.success) listener(parsed.data);
  });
}

/** Typed call into the host. This is the renderer's only way out of the sandbox. */
export async function invoke<C extends IpcChannel>(channel: C, payload: IpcRequest<C>): Promise<IpcResult<IpcResponse<C>>> {
  if (window.host === undefined) {
    return { ok: false, error: { code: "INTERNAL", message: "앱 안에서 실행해 주세요.", retryable: false } };
  }
  return (await window.host.invoke(channel, payload)) as IpcResult<IpcResponse<C>>;
}
