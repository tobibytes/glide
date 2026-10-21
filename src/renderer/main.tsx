import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/launcher.css";
import "./styles/settings.css";
import "./styles/workflow.css";
import { App } from "./App";

async function boot() {
  if (typeof window.glide === "undefined") {
    // Plain-browser development: install the in-memory mock bridge.
    const { createMockGlide } = await import("./dev/mockGlide");
    window.glide = createMockGlide();
    document.body.classList.add("dev-canvas");
  }
  const root = document.getElementById("root");
  if (!root) throw new Error("#root missing");
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void boot();
