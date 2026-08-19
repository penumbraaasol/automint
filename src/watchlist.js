import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';

const FILE = new URL('../.state/watchlist.json', import.meta.url).pathname;

export function load() {
  if (!existsSync(FILE)) return { entries: [] };
  try { return JSON.parse(readFileSync(FILE, 'utf8')); }
  catch { return { entries: [] }; }
}

export function save(wl) {
  mkdirSync(new URL('../.state/', import.meta.url).pathname, { recursive: true });
  writeFileSync(FILE, JSON.stringify(wl, null, 2));
}

export function add(slug, opts = {}) {
  const wl = load();
  if (wl.entries.some((e) => e.slug === slug)) return { added: false, reason: 'already watching' };
  wl.entries.push({
    slug,
    quantity: opts.quantity ?? 1,
    maxPrice: opts.maxPrice ?? null,
    addedAt: new Date().toISOString(),
    note: opts.note ?? null,
  });
  save(wl);
  return { added: true };
}

export function remove(slug) {
  const wl = load();
  const before = wl.entries.length;
  wl.entries = wl.entries.filter((e) => e.slug !== slug);
  save(wl);
  return { removed: before !== wl.entries.length };
}
