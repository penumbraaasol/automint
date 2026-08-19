export function duration(ms) {
  if (ms <= 0) return '0s';
  const s = Math.floor(ms / 1000);
  const parts = [
    [Math.floor(s / 86400), 'd'],
    [Math.floor((s % 86400) / 3600), 'h'],
    [Math.floor((s % 3600) / 60), 'm'],
    [s % 60, 's'],
  ].filter(([v], i) => v > 0 || i > 1);
  return parts.slice(0, 2).map(([v, u]) => `${v}${u}`).join(' ');
}

export const iso = (d) => new Date(d).toISOString().replace('T', ' ').slice(0, 19) + 'Z';
