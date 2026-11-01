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
