// Sandboxed preload: `electron` is the only module available here.
const { contextBridge, ipcRenderer } = require("electron");

// Must equal IpcChannels in @learningxxx/contracts; test/boundary.test.ts enforces it.
const CHANNELS = new Set([
  "collection.run",
  "collection.status",
  "library.manifest",
  "session.create",
  "session.list",
  "session.rename",
  "session.archive",
  "run.start",
  "run.cancel",
]);

contextBridge.exposeInMainWorld("host", {
  invoke(channel, payload) {
    if (!CHANNELS.has(channel)) return Promise.reject(new Error("unknown channel"));
    return ipcRenderer.invoke("host:invoke", { schemaVersion: 1, channel, payload });
  },
});
