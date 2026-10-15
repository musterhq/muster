// Build-time SEO for the static site:
//  1. Prerenders the React home page (src/story/App.jsx) into index.html so the
//     HTML Google reads first already carries the full text, headings and links.
//     The client still mounts with createRoot, so the page looks and behaves the same.
//  2. Injects shared JSON-LD (Organization, SoftwareApplication, WebSite) with the
//     softwareVersion taken from the latest GitHub release of musterhq/muster-code.
import { createRequire } from "node:module";
import { resolve, basename } from "node:path";
import { build as esbuild } from "esbuild";

const ORIGIN = "https://themuster.dev";
const FALLBACK = { version: "0.3.11", tag: "agent-v0.3.11", date: "2026-10-12" };
const REPO = "musterhq/muster-code";

async function latestRelease() {
  try {
    const headers = { accept: "application/vnd.github+json", "user-agent": "muster-website-build" };
    if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers, signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(String(res.status));
    const r = await res.json();
    const m = /(\d+\.\d+\.\d+)/.exec(r.tag_name ?? "");
    if (!m) throw new Error("no version");
    return { version: m[1], tag: r.tag_name, date: (r.published_at ?? "").slice(0, 10) || FALLBACK.date };
  } catch {
    return FALLBACK;
  }
}

function organization() {
  return {
    "@type": "Organization",
    "@id": `${ORIGIN}/#organization`,
    name: "Muster",
    url: `${ORIGIN}/`,
    logo: `${ORIGIN}/assets/brand/muster-logo.png`,
    description: "Muster builds Muster Agent, an open-source desktop app for coding agents.",
    sameAs: ["https://github.com/musterhq", "https://github.com/musterhq/muster-code", "https://github.com/musterhq/muster", "https://www.npmjs.com/package/@musterhq/cli"],
  };
}
function application(rel) {
  return {
    "@type": "SoftwareApplication",
    "@id": `${ORIGIN}/#agent-app`,
    name: "Muster Agent",
    alternateName: ["Muster Code", "Muster Agent desktop app"],
    description: "Muster Agent is a free, open-source desktop app that works with Codex (your ChatGPT sign-in), Claude Code, OpenCode, the Cursor Agent CLI, the Gemini CLI, any OpenAI-compatible model router (OmniRoute, OpenRouter, custom endpoints), any OpenAI-compatible API including Meta's Muse models (Muse Spark, Muse Wonder) through the Meta Model API, and local models (Ollama, LM Studio) and open-weight models you run locally. It adds long-term memory, scoped sandboxes, permission modes from read-only to full access, live diffs with Keep and Undo, a terminal, a browser, git history and local work on Paperclip tasks.",
    applicationCategory: "DeveloperApplication",
    applicationSubCategory: "AI coding agent",
    operatingSystem: "macOS, Windows, Linux",
    softwareVersion: rel.version,
    datePublished: rel.date,
    downloadUrl: `https://github.com/${REPO}/releases/latest`,
    installUrl: `${ORIGIN}/download.html`,
    url: `${ORIGIN}/download.html`,
    image: `${ORIGIN}/assets/brand/muster-og.png`,
    screenshot: [`${ORIGIN}/assets/screens/muster-agent-hero.jpg`, `${ORIGIN}/assets/screens/muster-agent-inline-diff.jpg`],
    license: "https://github.com/musterhq/muster-code/blob/main/LICENSE",
    isAccessibleForFree: true,
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    author: { "@id": `${ORIGIN}/#organization` },
    publisher: { "@id": `${ORIGIN}/#organization` },
  };
}
function website() {
  // No SearchAction: the site has no search.
  return { "@type": "WebSite", "@id": `${ORIGIN}/#website`, name: "Muster Agent", alternateName: ["Muster", "themuster.dev"], url: `${ORIGIN}/`, publisher: { "@id": `${ORIGIN}/#organization` } };
}

async function renderHome(root) {
  const out = await esbuild({
    entryPoints: [resolve(root, "src/story/App.jsx")],
    bundle: true, write: false, platform: "node", format: "cjs", jsx: "automatic",
    loader: { ".jsx": "jsx", ".css": "empty", ".json": "json", ".svg": "dataurl", ".png": "dataurl" },
    external: ["react", "react-dom", "react-dom/server", "react/jsx-runtime", "three", "gsap"],
    logLevel: "silent",
  });
  const require = createRequire(resolve(root, "package.json"));
  const mq = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  globalThis.matchMedia ??= mq;
  const mod = { exports: {} };
  new Function("require", "module", "exports", out.outputFiles[0].text)(require, mod, mod.exports);
  const React = require("react");
  const { renderToString } = require("react-dom/server");
  return renderToString(React.createElement(React.StrictMode, null, React.createElement(mod.exports.App)));
}

export default function seoPlugin() {
  let root = process.cwd();
  let isBuild = false;
  let rel = FALLBACK;
  let homeHtml = null;
  const SHARED = {
    "index.html": ["org", "web", "app"],
    "download.html": ["org", "app"],
    "overview.html": ["org", "app"],
  };
  return {
    name: "muster-seo",
    configResolved(cfg) { root = cfg.root; isBuild = cfg.command === "build"; },
    async buildStart() { if (isBuild) { rel = await latestRelease(); homeHtml = await renderHome(root); } },
    transformIndexHtml(html, ctx) {
      if (!isBuild) return html;
      const file = basename(ctx.filename ?? "");
      if (file === "index.html" && homeHtml) html = html.replace('<div id="root"></div>', `<div id="root">${homeHtml}</div>`);
      const parts = SHARED[file];
      if (parts) {
        const graph = [];
        if (parts.includes("org")) graph.push(organization());
        if (parts.includes("web")) graph.push(website());
        if (parts.includes("app")) graph.push(application(rel));
        const tag = `<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@graph": graph })}</script>`;
        html = html.replace("</head>", `${tag}\n</head>`);
      }
      return html;
    },
  };
}
