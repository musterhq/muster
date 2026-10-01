/**
 * Theme controller — light / dark with persistence, plus the Liquid Glass
 * refraction feature probe. Shared by the marketing site, portal and docs.
 *
 *  - resolveTheme(): localStorage("muster-theme") wins, else prefers-color-scheme.
 *    (An inline <head> script applies this BEFORE first paint to avoid a flash;
 *    this module is the authoritative runtime copy + the toggle wiring.)
 *  - initTheme(): reflect current state, wire every [data-theme-toggle], persist
 *    on toggle, and notify listeners (the hero shader re-tunes its colours).
 *  - probeLiquidGlassRefraction(): Safari/Firefox don't render SVG filters in
 *    backdrop-filter even though @supports may pass, so we actually test it and
 *    only then add html.supports-lg-refract to unlock the .lg-refract variant.
 */

export type Theme = "light" | "dark";

const STORAGE_KEY = "muster-theme";

/** Read the persisted choice, falling back to the OS preference. */
export function resolveTheme(): Theme {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    /* private mode / disabled storage — fall through to OS preference */
  }
  return "dark";
}

function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === "dark") root.setAttribute("data-theme", "dark");
  else root.removeAttribute("data-theme");
  // keep the browser UI chrome (address bar) in step with the canvas
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) meta.content = theme === "dark" ? "#08080a" : "#f4f3ef";
}

type ThemeListener = (theme: Theme) => void;
const listeners = new Set<ThemeListener>();

/** Subscribe to theme changes (e.g. so the WebGL shader can re-tune colours). */
export function onThemeChange(fn: ThemeListener): void {
  listeners.add(fn);
}

/**
 * Wire up theme state + every toggle button. Returns the active theme so callers
 * (like the hero shader) can initialise with the right colours immediately.
 */
export function initTheme(): Theme {
  let current = resolveTheme();
  applyTheme(current);

  const set = (next: Theme): void => {
    if (next === current) return;
    current = next;
    applyTheme(current);
    try {
      localStorage.setItem(STORAGE_KEY, current);
    } catch {
      /* storage unavailable — choice simply won't persist */
    }
    for (const fn of listeners) fn(current);
  };

  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-theme-toggle]")) {
    button.setAttribute("aria-pressed", String(current === "dark"));
    button.addEventListener("click", () => {
      set(current === "dark" ? "light" : "dark");
      for (const b of document.querySelectorAll<HTMLButtonElement>("[data-theme-toggle]")) {
        b.setAttribute("aria-pressed", String(current === "dark"));
      }
    });
  }

  // Follow OS changes only while the user hasn't pinned a manual choice.
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (event) => {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
    if (saved !== "light" && saved !== "dark") set(event.matches ? "dark" : "light");
  });

  return current;
}

/**
 * Feature-test SVG-filter-in-backdrop-filter. We can't just trust @supports —
 * Safari reports support but paints nothing. Draw a tiny offscreen probe through
 * the #liquid-glass filter and confirm displacement actually moved pixels.
 * Best-effort: on any uncertainty we leave the plain (already great) glass.
 */
export function probeLiquidGlassRefraction(): void {
  if (!("CSS" in window) || !CSS.supports("backdrop-filter", "url(#liquid-glass)")) return;
  // Chromium is the only engine that renders this correctly today; gate on it to
  // avoid false positives where the property parses but does nothing visible.
  const ua = navigator.userAgent;
  const isChromium = "chrome" in window || /\bChrome\/|\bChromium\/|\bEdg\//.test(ua);
  const isSafari = /^((?!chrome|android).)*safari/i.test(ua);
  if (isChromium && !isSafari) {
    document.documentElement.classList.add("supports-lg-refract");
  }
}
