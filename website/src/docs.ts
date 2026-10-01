import "./portal.css";
import { initTheme } from "./theme";
import "./site-theme.css";

// Light/dark toggle (shared controller) — wires the nav button + persistence.
initTheme();

// Highlight the rail item for the section currently in view.
const railLinks = Array.from(document.querySelectorAll<HTMLAnchorElement>(".rail a.rail-item"));
const sections = Array.from(document.querySelectorAll<HTMLElement>(".docs-section"));

function setActive(id: string): void {
  for (const link of railLinks) link.classList.toggle("active", link.getAttribute("href") === `#${id}`);
}

const observer = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) setActive(entry.target.id);
    }
  },
  { rootMargin: "-20% 0px -70% 0px" },
);
for (const section of sections) observer.observe(section);
if (sections[0]) setActive(sections[0].id);
