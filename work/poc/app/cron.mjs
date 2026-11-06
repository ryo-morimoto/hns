// Minimal 5-field cron: minute hour dom month dow. Local time. Supports * , - /.
const FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "dom", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "dow", min: 0, max: 6 },
];

function parseField(text, { min, max }) {
  const values = new Set();
  for (const part of text.split(",")) {
    let step = 1;
    let range = part;
    if (part.includes("/")) {
      const [left, right] = part.split("/");
      range = left;
      step = Number(right);
      if (!Number.isInteger(step) || step < 1) throw new Error("bad step: " + part);
    }
    let start = min, end = max;
    if (range !== "*") {
      if (range.includes("-")) {
        const [a, b] = range.split("-").map(Number);
        start = a; end = b;
      } else {
        start = Number(range); end = start;
      }
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end) {
        throw new Error("bad field: " + part);
      }
    }
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return values;
}

export function parseCron(expression) {
  const parts = String(expression).trim().split(/\s+/);
  if (parts.length !== 5) throw new Error("cron needs 5 fields");
  const sets = parts.map((text, index) => parseField(text, FIELDS[index]));
  return { minute: sets[0], hour: sets[1], dom: sets[2], month: sets[3], dow: sets[4] };
}

export function cronMatches(expression, date) {
  const cron = typeof expression === "string" ? parseCron(expression) : expression;
  if (!cron.minute.has(date.getMinutes())) return false;
  if (!cron.hour.has(date.getHours())) return false;
  if (!cron.month.has(date.getMonth() + 1)) return false;
  const dom = cron.dom.has(date.getDate());
  const dow = cron.dow.has(date.getDay());
  // Standard cron: when both day fields are restricted, either may match.
  const domRestricted = cron.dom.size < 31;
  const dowRestricted = cron.dow.size < 7;
  if (domRestricted && dowRestricted) return dom || dow;
  return dom && dow;
}
