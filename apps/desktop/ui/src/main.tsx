import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { installFakeHost } from "./fake-host.ts";
import { FIXTURE_MANIFEST } from "./fixtures.ts";
import { TranscriptDemo } from "./TranscriptDemo.tsx";
import "./styles.css";
import { GuidedPreview } from './GuidedPreview.tsx';

// `?fixture` in a plain browser: an in-memory host so the chat flow can be tried. Never inside the app.
const browserPreview = window.host === undefined && new URLSearchParams(window.location.search).has('guidedPreview');
if ((new URLSearchParams(window.location.search).has("fixture") || browserPreview) && window.host === undefined) installFakeHost(FIXTURE_MANIFEST.course.title);

const root = document.getElementById("root");
if (root === null) throw new Error("missing root element");
createRoot(root).render(
  <StrictMode>
    {browserPreview ? <GuidedPreview /> : new URLSearchParams(window.location.search).has("mediaFixture") && window.host === undefined ? <TranscriptDemo /> : <App />}
  </StrictMode>,
);
