// Cron validation/description for Auto Task schedules. Standard five fields (minute hour day-of-month month
// day-of-week); supports *, lists, ranges and steps. It does not claim to be the scheduler: execution remains a later
// port phase, but an invalid expression is refused before it can be saved.
const RANGES: ReadonlyArray<[number, number]> = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];

function fieldOk(field: string, min: number, max: number): boolean {
  if (field === "*") return true;
  for (const part of field.split(",")) {
    if (part === "") return false;
    // The step is split off first, so a range step (`0-30/10`) is checked against its range like a plain one.
    const pieces = part.split("/");
    if (pieces.length > 2) return false;
    const base = pieces[0] ?? "";
    const step = pieces[1];
    if (step !== undefined && (!/^\d+$/.test(step) || Number(step) <= 0)) return false;
    // A step needs a range or `*` to count from; `5/10` is not a form cronMatches supports.
    if (step !== undefined && base !== "*" && !base.includes("-")) return false;
    if (base === "*") continue;
    if (base.includes("-")) {
      const bounds = base.split("-");
      if (bounds.length !== 2) return false;
      const [a = "", b = ""] = bounds;
      if (!/^\d+$/.test(a) || !/^\d+$/.test(b) || Number(a) < min || Number(b) > max || Number(a) > Number(b)) return false;
    } else if (!/^\d+$/.test(base) || Number(base) < min || Number(base) > max) {
      return false;
    }
  }
  return true;
}

export function validateCron(expr: string): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  return fields.every((f, i) => fieldOk(f, RANGES[i][0], RANGES[i][1]));
}

export function describeCron(expr: string): string {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5 || !validateCron(expr)) return "Invalid cron expression";
  if (expr.trim() === "* * * * *") return "Every minute";
  if (f[0] === "0" && f[1] === "*") return "Every hour";
  if (f[0] === "0" && f[1] !== "*" && f[2] === "*" && f[3] === "*" && f[4] === "*") return `Every day at ${f[1].padStart(2, "0")}:00`;
  if (f[2] === "*" && f[3] === "*" && f[4] === "1-5" && f[0] !== "*" && f[1] !== "*") return `Weekdays at ${f[1].padStart(2, "0")}:${f[0].padStart(2, "0")}`;
  return "Custom schedule";
}

/** Vixie-style five-field match. Supports star, star-slash-step, a-b, a-b/step, lists and exact numbers. When both day fields are
 *  restricted, either may match (standard cron OR). */
export function cronMatches(expr: string, at: Date): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [min, hour, dom, month, dowSpec] = parts;
  const field = (spec: string, value: number, lo: number, hi: number): boolean => {
    for (const piece of spec.split(",")) {
      const [range, stepRaw] = piece.split("/");
      const step = stepRaw === undefined ? 1 : Number(stepRaw);
      if (!Number.isInteger(step) || step <= 0) return false;
      let a = lo; let b = hi;
      if (range !== "*") {
        const [sa, sb] = range.split("-");
        a = Number(sa); b = sb === undefined ? a : Number(sb);
        if (!Number.isInteger(a) || !Number.isInteger(b)) return false;
      }
      if (value < a || value > b) continue;
      if ((value - a) % step === 0) return true;
    }
    return false;
  };
  const m = field(min, at.getMinutes(), 0, 59);
  const h = field(hour, at.getHours(), 0, 23);
  const domOk = field(dom, at.getDate(), 1, 31);
  const mon = field(month, at.getMonth() + 1, 1, 12);
  // validateCron accepts 0-7 for day-of-week; 7 is Sunday too (Vixie cron), so a Sunday also matches a 7.
  const dowOk = field(dowSpec, at.getDay(), 0, 6) || (at.getDay() === 0 && field(dowSpec, 7, 0, 7));
  const domRestricted = dom !== "*"; const dowRestricted = dowSpec !== "*";
  const dayOk = domRestricted && dowRestricted ? (domOk || dowOk) : (domOk && dowOk);
  return m && h && mon && dayOk;
}

/** The first minute after `from` that the expression matches, searched up to a year ahead; null when none does (for
 *  example Feb 31) or the expression is invalid. Uses cronMatches itself, but skips a whole day or hour that cannot
 *  match, so a yearly or never-firing expression costs a few thousand checks, not half a million (it runs on render). */
export function nextFireAfter(expr: string, from: Date, horizonMinutes = 366 * 24 * 60): Date | null {
  if (!validateCron(expr)) return null;
  const [, hour, dom, month, dow] = expr.trim().split(/\s+/);
  const dayExpr = `* * ${dom} ${month} ${dow}`;
  const hourExpr = `* ${hour} ${dom} ${month} ${dow}`;
  const end = from.getTime() + horizonMinutes * 60_000;
  const t = new Date(from.getTime());
  t.setSeconds(0, 0);
  t.setMinutes(t.getMinutes() + 1);
  while (t.getTime() <= end) {
    if (!cronMatches(dayExpr, t)) { t.setDate(t.getDate() + 1); t.setHours(0, 0, 0, 0); continue; }
    if (!cronMatches(hourExpr, t)) { t.setHours(t.getHours() + 1, 0, 0, 0); continue; }
    if (cronMatches(expr, t)) return new Date(t.getTime());
    t.setMinutes(t.getMinutes() + 1);
  }
  return null;
}

/** "Mon 09:30" style, as the Mac's fire formatter ("EEE HH:mm"). */
export function fireLabel(d: Date): string {
  const day = d.toLocaleDateString(undefined, { weekday: "short" });
  return `${day} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
