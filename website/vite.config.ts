import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  // The verified custom domain serves the website at the domain root.
  base: process.env.VITE_BASE_PATH ?? "/",
  build: {
    target: "es2022",
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        overview: resolve(__dirname, "overview.html"),
        notFound: resolve(__dirname, "404.html"),
        portal: resolve(__dirname, "portal.html"),
        docs: resolve(__dirname, "docs.html"),
        frappeAi: resolve(__dirname, "frappe-ai.html"),
        agentHarness: resolve(__dirname, "agent-harness.html"),
        mcpAgentHarness: resolve(__dirname, "mcp-agent-harness.html"),
        slackAiAgent: resolve(__dirname, "slack-ai-agent.html"),
        telegramAiAgent: resolve(__dirname, "telegram-ai-agent.html"),
        googleChatAiAgent: resolve(__dirname, "google-chat-ai-agent.html"),
        browserAutomationAgent: resolve(__dirname, "browser-automation-agent.html"),
        guides: resolve(__dirname, "guides.html"),
        guideAgentHarness: resolve(__dirname, "guide-agent-harness.html"),
        guideMcpAgentHarness: resolve(__dirname, "guide-mcp-agent-harness.html"),
        guideFrappeAi: resolve(__dirname, "guide-frappe-ai.html"),
        guideGovernedMemory: resolve(__dirname, "guide-governed-memory.html"),
        // Comparison / alternative pages + the evidence feature page. These are
        // the pages that carry the long-form static prose, so they must be in
        // this list or they never reach dist and their canonicals point at a
        // 404 — which is exactly the state roadmap.html is in: it is NOT listed
        // here because src/roadmap.ts imports ./roadmap.css, which has never
        // existed in the repo, so adding it breaks the build. Until that CSS
        // lands, roadmap.html is undeployable and stays out of the sitemap too.
        liveInlineDiff: resolve(__dirname, "live-inline-diff.html"),
        musterVsOpenclaw: resolve(__dirname, "muster-vs-openclaw.html"),
        musterVsHermesAgent: resolve(__dirname, "muster-vs-hermes-agent.html"),
        musterVsQm: resolve(__dirname, "muster-vs-qm.html"),
        resumeCodexSessions: resolve(__dirname, "resume-codex-sessions.html"),
        onboarding: resolve(__dirname, "onboarding.html"),
        spatial: resolve(__dirname, "spatial.html"),
        download: resolve(__dirname, "download.html")
      }
    }
  }
});
