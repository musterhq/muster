import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
const root = new URL('../', import.meta.url);
const skip = new Set(['404.html', 'portal.html', 'onboarding.html', 'spatial.html', 'roadmap.html', 'open-source-codex-desktop-app.html']);
const pages = [...readdirSync(root).filter((f) => f.endsWith('.html') && !skip.has(f)), ...readdirSync(new URL('blog/', root)).filter((f) => f.endsWith('.html')).map((f) => `blog/${f}`)];
const sitemap = readFileSync(new URL('public/sitemap.xml', root), 'utf8');
const decode = (s) => s.replace(/&amp;/g, '&');

test('every public page is in the sitemap with a lastmod', () => {
  for (const f of pages) {
    const loc = f === 'index.html' ? 'https://themuster.dev/' : f === 'blog/index.html' ? 'https://themuster.dev/blog/' : `https://themuster.dev/${f}`;
    assert.match(sitemap, new RegExp(`<loc>${loc.replace(/[.]/g, '\\.')}</loc>\\s*<lastmod>\\d{4}-\\d{2}-\\d{2}</lastmod>`), f);
  }
});
test('each public page has a unique <60 char title, <155 char description, canonical and one text h1', () => {
  const titles = new Set();
  for (const f of pages) {
    const h = readFileSync(new URL(f, root), 'utf8');
    const title = decode((h.match(/<title>([^<]*)<\/title>/) || [])[1] || '');
    const desc = decode((h.match(/name="description" content="([^"]*)"/) || [])[1] || '');
    assert.ok(title && title.length < 60, `${f} title ${title.length}`);
    assert.ok(desc && desc.length < 155, `${f} description ${desc.length}`);
    assert.ok(!titles.has(title), `${f} duplicate title`);
    titles.add(title);
    assert.match(h, /<link rel="canonical" href="https:\/\/themuster\.dev\//, f);
    assert.match(h, /property="og:title"/, f);
    assert.match(h, /name="twitter:title"/, f);
  }
});
test('home h1 is text, not an image', () => {
  const app = readFileSync(new URL('src/story/App.jsx', root), 'utf8');
  assert.match(app, /<h1 className='sr-only'>Muster Agent: the open-source AI Development Environment \(ADE\)<\/h1>/);
});
test('robots allows all and points at the sitemap', () => {
  const r = readFileSync(new URL('public/robots.txt', root), 'utf8');
  assert.match(r, /User-agent: \*\nAllow: \//);
  assert.match(r, /Sitemap: https:\/\/themuster\.dev\/sitemap\.xml/);
});

test('blog posts carry BlogPosting schema dated today with Muster as author, and are in the RSS feed', () => {
  const rss = readFileSync(new URL('public/blog/rss.xml', root), 'utf8');
  for (const f of pages.filter((p) => p.startsWith('blog/') && p !== 'blog/index.html')) {
    const h = readFileSync(new URL(f, root), 'utf8');
    assert.match(h, /"@type": "BlogPosting"/, f);
    assert.match(h, /"datePublished": "2026-10-15"/, f);
    assert.match(h, /"dateModified": "2026-10-15"/, f);
    assert.match(h, /"name": "Muster"/, f);
    assert.ok(rss.includes(`https://themuster.dev/${f}`), `${f} missing from rss`);
  }
});
test('no site source names a forbidden company', () => {
  for (const f of pages) assert.doesNotMatch(readFileSync(new URL(f, root), 'utf8'), /hybrow/i, f);
});
