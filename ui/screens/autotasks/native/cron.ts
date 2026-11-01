// Cron validation/description for Auto Task schedules. Standard five fields (minute hour day-of-month month
// day-of-week); supports *, lists, ranges and steps. It does not claim to be the scheduler: execution remains a later
// port phase, but an invalid expression is refused before it can be saved.
const RANGES: ReadonlyArray<[number, number]> = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];

function fieldOk(field: string, min: number, max: number): boolean {
  if (field === "*") return true;
  for (const part of field.split(",")) {
    if (part === "") return false;
    let base = part;
    const stepMatch = /^\*\/(\d+)$/.exec(part);
    if (stepMatch) { base = "*"; if (Number(stepMatch[1]) <= 0) return false; }
    const step = part.includes("/") ? part.split("/")[1] : null;
    if (step !== null && (!/^\d+$/.test(step) || Number(step) <= 0)) return false;
    if (base.includes("-")) {
      const [a, b] = base.split("-");
      if (!/^\d+$/.test(a) || !/^\d+$/.test(b) || Number(a) < min || Number(b) > max || Number(a) > Number(b)) return false;
    } else if (base !== "*") {
      if (!/^\d+$/.test(base) || Number(base) < min || Number(base) > max) return false;
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
  const dowOk = field(dowSpec, at.getDay(), 0, 6);
  const domRestricted = dom !== "*"; const dowRestricted = dowSpec !== "*";
  const dayOk = domRestricted && dowRestricted ? (domOk || dowOk) : (domOk && dowOk);
  return m && h && mon && dayOk;
}
