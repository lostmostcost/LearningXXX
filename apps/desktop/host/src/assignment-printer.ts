import { randomUUID } from 'node:crypto';
import { BrowserWindow, session } from 'electron';
export const ASSIGNMENT_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'";
/** Untrusted chat-edited HTML gets no scripts, network, cookies or permissions. */
export async function printAssignment(html: string, signal: AbortSignal): Promise<Uint8Array> {
  signal.throwIfAborted();
  const isolated = session.fromPartition(`assignment-print-${randomUUID()}`);
  isolated.setPermissionRequestHandler((_contents, _permission, answer) => answer(false));
  isolated.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, answer) => answer({ cancel: !details.url.startsWith('data:') && details.url !== 'about:blank' }));
  const window = new BrowserWindow({ show: false, webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', e => e.preventDefault());
  const stop = () => { if (!window.isDestroyed()) window.destroy(); };
  signal.addEventListener('abort', stop, { once: true });
  try {
    const secure = `<!doctype html><meta http-equiv="Content-Security-Policy" content="${ASSIGNMENT_CSP}">` + html.replace(/<!doctype[^>]*>/gi, '');
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(secure)}`); signal.throwIfAborted();
    const result = await window.webContents.printToPDF({ printBackground: true, pageSize: 'A4', preferCSSPageSize: true });
    signal.throwIfAborted(); return result;
  } finally { signal.removeEventListener('abort', stop); stop(); isolated.webRequest.onBeforeRequest(null); }
}
