import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.jsx";
import "./styles.css";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// Preserve previously shared home section links in the retained technical overview.
const overviewSections = new Set(["liquid-glass", "liquid-glass-nav", "scroll-progress", "hero-stage", "hero-canvas", "hero", "install-cmd", "download", "agent-app-title", "terminal", "term-window", "term-out", "problem", "solution", "definitions", "use-cases", "capabilities", "architecture", "proof", "compare", "positioning", "year"]);
if (overviewSections.has(location.hash.slice(1))) location.replace('/overview.html' + location.hash);
