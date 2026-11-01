// Sandboxed preload: `electron` is the only module available here.
const { contextBridge, ipcRenderer } = require("electron");

// Must equal IpcChannels in @learningxxx/contracts; test/boundary.test.ts enforces it.
const CHANNELS = new Set([
  "collection.run",
  "collection.status",
  "library.manifest",
  "library.courses",
  "library.asset",
  "session.create",
  "session.list",
  "session.rename",
  "session.archive",
  "captures.start",
  "attachments.chooseLocal",
  "attachments.prepareAsset",
  "attachments.confirm",
  "attachments.remove",
  "run.start",
  "run.cancel",
  "files.chooseFolder",
  "files.removeFolder",
  "files.changes",
  "files.sessionChanges",
  "files.restore",
  "files.trash",
]);

contextBridge.exposeInMainWorld("host", {
  invoke(channel, payload) {
    if (!CHANNELS.has(channel)) return Promise.reject(new Error("unknown channel"));
    return ipcRenderer.invoke("host:invoke", { schemaVersion: 1, channel, payload });
  },
  // The listener receives only the message, never the Electron event object.
  onPush(listener) {
    const forward = (_event, message) => listener(message);
    ipcRenderer.on("host:push", forward);
    return () => ipcRenderer.removeListener("host:push", forward);
  },
});
