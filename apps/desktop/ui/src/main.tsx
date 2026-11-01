import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { installFakeHost } from "./fake-host.ts";
import { FIXTURE_MANIFEST } from "./fixtures.ts";
import "./styles.css";

// `?fixture` in a plain browser: an in-memory host so the chat flow can be tried. Never inside the app.
if (new URLSearchParams(window.location.search).has("fixture") && window.host === undefined) installFakeHost(FIXTURE_MANIFEST.course.title);

const root = document.getElementById("root");
if (root === null) throw new Error("missing root element");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
