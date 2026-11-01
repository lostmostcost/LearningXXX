/** Renderer isolation from ADR-002. test/boundary.test.ts pins these values. */
export const WEB_PREFERENCES = {
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  webviewTag: false,
} as const;

export const WINDOW_SIZE = { width: 1280, height: 800, minWidth: 640, minHeight: 480 } as const;

/** The login window shows remote pages, so it gets no preload and no Node access. */
export const LOGIN_WEB_PREFERENCES = {
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  webviewTag: false,
} as const;

/** School single sign-on may cross hosts, but never leaves encrypted transport. */
export const isAllowedLoginUrl = (url: string): boolean => url.startsWith("https://");
