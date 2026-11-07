/** Compact relative time for the workspace rows: now / 12m / 3h / 2d. */
export function formatRelative(iso: string | null, now: Date = new Date()): string {
  if (iso === null) return "—";
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return "—";
  const minutes = Math.floor((now.getTime() - time) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return String(minutes) + "m";
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return String(hours) + "h";
  return String(Math.floor(hours / 24)) + "d";
}
