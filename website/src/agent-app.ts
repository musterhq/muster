/**
 * Muster Agent download band + 3D video stage.
 *
 *  - One-click download: the primary button points at the installer for the
 *    visitor's OS. Links are baked into the HTML for the current release so they
 *    work without JS; on load we ask GitHub for the newest agent-v* release and
 *    swap in its assets, so the site never needs a redeploy for a new version.
 *  - 3D stage: the demo video sits on a device in perspective. It flattens as it
 *    scrolls into view and leans toward the cursor; the feature chips float at
 *    different depths. Static under reduced motion, no cursor lean on touch.
 */

const REPO = "musterhq/muster-code";
const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

type Os = "mac" | "win" | "linux";
type AssetKey = "mac-dmg" | "win-exe" | "linux-appimage" | "linux-deb";

const ASSET_MATCH: Record<AssetKey, RegExp> = {
  "mac-dmg": /-arm64\.dmg$/,
  "win-exe": /-win-x64-setup\.exe$/,
  "linux-appimage": /\.AppImage$/,
  "linux-deb": /\.deb$/,
};

const PRIMARY: Record<Os, { asset: AssetKey; label: string; meta: string }> = {
  mac: { asset: "mac-dmg", label: "Download for macOS", meta: "Apple silicon · .dmg" },
  win: { asset: "win-exe", label: "Download for Windows", meta: "Windows 10/11 · installer .exe" },
  linux: { asset: "linux-appimage", label: "Download for Linux", meta: "x64 · .AppImage" },
};

function detectOs(): Os {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = (nav.userAgentData?.platform || navigator.platform || navigator.userAgent).toLowerCase();
  if (platform.includes("win")) return "win";
  if (platform.includes("linux") || platform.includes("x11") || platform.includes("cros") || platform.includes("chrome os")) return "linux";
  return "mac";
}

interface ReleaseAsset { name: string; browser_download_url: string }
interface Release { tag_name: string; draft: boolean; prerelease: boolean; assets: ReleaseAsset[] }

async function latestAgentRelease(): Promise<Release | null> {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=15`, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) return null;
    const releases = (await res.json()) as Release[];
    return releases.find(r => !r.draft && !r.prerelease && r.tag_name.startsWith("agent-v")) ?? null;
  } catch {
    return null; // offline or rate-limited: the baked-in links stay
  }
}

function initDownloads(): void {
  const os = detectOs();
  const primary = PRIMARY[os];
  const button = document.querySelector<HTMLAnchorElement>("[data-download-primary] a");
  const grid = new Map<AssetKey, HTMLAnchorElement>();
  for (const a of document.querySelectorAll<HTMLAnchorElement>("[data-asset]")) {
    grid.set(a.dataset["asset"] as AssetKey, a);
  }
  const hrefFor = (key: AssetKey) => grid.get(key)?.href;

  const paint = () => {
    if (button) {
      const href = hrefFor(primary.asset);
      if (href) button.href = href;
      button.querySelector(".dl-label")!.textContent = primary.label;
      button.querySelector("[data-dl-meta]")!.textContent = primary.meta;
    }
    // Other one-click buttons on the page (hero CTA) follow the same OS pick.
    for (const a of document.querySelectorAll<HTMLAnchorElement>("[data-os-link]")) {
      if (a === button) continue;
      const href = hrefFor(primary.asset);
      if (href) a.href = href;
      a.textContent = primary.label;
    }
    for (const [key, a] of grid) a.parentElement?.classList.toggle("is-yours", key === primary.asset);
  };
  paint();

  void latestAgentRelease().then(release => {
    if (!release) return;
    for (const [key, a] of grid) {
      const asset = release.assets.find(x => ASSET_MATCH[key].test(x.name));
      if (asset) a.href = asset.browser_download_url;
    }
    const version = release.tag_name.replace(/^agent-/, "");
    for (const el of document.querySelectorAll("[data-release-version]")) el.textContent = version;
    paint();
  });
}

function initStage(): void {
  const stage = document.querySelector<HTMLElement>("[data-agent-stage]");
  if (!stage) return;
  const video = stage.querySelector<HTMLVideoElement>("video");

  // Only play while visible: saves battery and bandwidth further down the page.
  if (video) {
    if (REDUCED) { video.removeAttribute("autoplay"); video.pause(); video.controls = true; }
    new IntersectionObserver(([entry]) => {
      if (REDUCED || !entry) return;
      if (entry.isIntersecting) void video.play().catch(() => {});
      else video.pause();
    }, { threshold: 0.2 }).observe(stage);
  }
  if (REDUCED) return;

  const canHover = !window.matchMedia("(hover: none), (pointer: coarse)").matches;
  let scroll = 0, px = 0, py = 0, tpx = 0, tpy = 0, raf = 0;

  const measure = () => {
    const rect = stage.getBoundingClientRect();
    const vh = window.innerHeight || 1;
    // 0 when the stage enters from below, 1 when its centre reaches mid-screen.
    scroll = Math.min(1, Math.max(0, (vh - rect.top) / (vh * 0.5 + rect.height * 0.5)));
  };

  const frame = () => {
    raf = 0;
    px += (tpx - px) * 0.12;
    py += (tpy - py) * 0.12;
    const lean = 1 - scroll; // tilted on entry, settling as it arrives
    stage.style.setProperty("--rx", `${(14 * lean + py * -6).toFixed(2)}deg`);
    stage.style.setProperty("--ry", `${(-24 * lean + px * 10 - 6).toFixed(2)}deg`);
    stage.style.setProperty("--lift", `${(lean * 60).toFixed(1)}px`);
    stage.style.setProperty("--spread", scroll.toFixed(3));
    if (Math.abs(tpx - px) > 0.001 || Math.abs(tpy - py) > 0.001) raf = requestAnimationFrame(frame);
  };
  const kick = () => { if (!raf) raf = requestAnimationFrame(frame); };

  window.addEventListener("scroll", () => { measure(); kick(); }, { passive: true });
  window.addEventListener("resize", () => { measure(); kick(); });
  if (canHover) {
    stage.addEventListener("pointermove", event => {
      const rect = stage.getBoundingClientRect();
      tpx = (event.clientX - rect.left) / rect.width - 0.5;
      tpy = (event.clientY - rect.top) / rect.height - 0.5;
      kick();
    });
    stage.addEventListener("pointerleave", () => { tpx = 0; tpy = 0; kick(); });
  }
  stage.classList.add("is-3d");
  measure();
  kick();
}

export function initAgentApp(): void {
  initDownloads();
  initStage();
}
