import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
const root = new URL('../', import.meta.url);
const skip = new Set(['404.html', 'portal.html', 'onboarding.html', 'spatial.html', 'roadmap.html']);
const pages = readdirSync(root).filter((f) => f.endsWith('.html') && !skip.has(f));
const sitemap = readFileSync(new URL('public/sitemap.xml', root), 'utf8');
const decode = (s) => s.replace(/&amp;/g, '&');

test('every public page is in the sitemap with a lastmod', () => {
  for (const f of pages) {
    const loc = f === 'index.html' ? 'https://themuster.dev/' : `https://themuster.dev/${f}`;
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
  assert.match(app, /<h1 className='sr-only'>Muster Agent: the open-source AI coding agent desktop app<\/h1>/);
});
test('robots allows all and points at the sitemap', () => {
  const r = readFileSync(new URL('public/robots.txt', root), 'utf8');
  assert.match(r, /User-agent: \*\nAllow: \//);
  assert.match(r, /Sitemap: https:\/\/themuster\.dev\/sitemap\.xml/);
});
