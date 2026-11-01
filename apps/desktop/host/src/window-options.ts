/** Renderer isolation from ADR-002. test/boundary.test.ts pins these values. */
export const WEB_PREFERENCES = {
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  webviewTag: false,
} as const;

export const WINDOW_SIZE = { width: 1280, height: 800, minWidth: 640, minHeight: 480 } as const;
