# Muster website

Static Vite website for `https://themuster.dev`. The homepage is the approved v4 React/Three.js story. The guides, downloads, docs and previews keep their existing TypeScript behavior and content, with a shared neutral theme in `src/site-theme.css`.

## Develop and verify

```sh
pnpm install --frozen-lockfile
pnpm --filter muster-website dev
pnpm --filter muster-website typecheck
pnpm --filter muster-website test
VITE_BASE_PATH=/ pnpm --filter muster-website build
pnpm --filter muster-website preview
```

The story tests cover the illustrative requirement, delegation, native workbench anatomy, filter failure/correction, and server-rendered markup. Browser QA additionally needs desktop/mobile scrolling, pointer behavior, motion toggles, chat selection, profiles/tasks, browser filtering, PR panes, keyboard navigation, video and graphics fallback.

## Routes and production

- `/`: external chat → human mention → delegation → agents → code → browser inspection → reviewed change. The interactions are local illustrations and create no real messages, tasks or pull requests. Supporting availability copy distinguishes gateway, server and desktop behavior.
- `/overview.html`: the previous homepage's complete runtime, integration, benchmark, comparison and download content. Previously shared homepage section fragments redirect here.
- The existing 20 sitemap URLs, docs/download pages and three noindex previews (`portal.html`, `onboarding.html`, `spatial.html`) remain intact.
- `roadmap.html` is retained in source but remains outside the build and sitemap because its pre-existing `roadmap.css` import is missing.
- `404.html` supplies a static missing-page response; there is no SPA catch-all that replaces existing URLs.

The existing `.github/workflows/pages.yml` publishes `website/dist` from `main` after the normal PR/CI flow. The verified custom domain uses base `/`; preserve `public/CNAME`, `robots.txt`, `sitemap.xml` and production canonical URLs. Root-absolute public assets assume this existing domain-root setup.

## Source and licenses

Approved v4 source commit: `67ce2eea04a84993fa4c8f4d62b34d4dafb8fa61`. Transfer archive SHA-256: `89e671fb27e370b007040c239e0716765de5444353b426e6d0e3b0487ecf963c`.

The user supplied the product video and current task-review screenshot. Three.js Helvetiker lettering retains `public/assets/helvetiker-license.txt` and the embedded font license. `muster-wordmark.svg` and `wordmarkContours.json` are continuous nested contours derived from that licensed typeface for loading, reduced-motion and WebGL-failure states. DM Sans and Space Grotesk load from Google Fonts with local font fallbacks. The original product/runtime files are independent of this static website.
