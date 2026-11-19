import { useState, type ReactNode } from "react";

export interface SkillChoice { id: string; name: string }

// The ids the run resolves are exactly the skill library's (`readSkillInstructions` looks the id up in it). Their
// shape varies (`skills/x`, `catalog/<publisher>__<name>/<dir>`, folder names with spaces), so any short string passes.
const MAX_ID = 300;

export function decodeSkillChoices(raw: unknown): SkillChoice[] {
  const list = (raw as { skills?: unknown } | null)?.skills;
  if (!Array.isArray(list)) return [];
  const out: SkillChoice[] = [];
  for (const s of list) {
    const o = s as { id?: unknown; name?: unknown } | null;
    if (o && typeof o.id === "string" && o.id.trim() === o.id && o.id && o.id.length <= MAX_ID) out.push({ id: o.id, name: typeof o.name === "string" ? o.name : o.id });
  }
  return out;
}

/** A text field that suggests the available skills. Any id can still be typed, and a stored id that is not in the
 *  list stays as it is; with no list (still loading, or failed) it is the plain field. */
export function SkillIdField({ value, skills, onChange }: { value: string; skills: SkillChoice[] | null; onChange: (id: string) => void }): ReactNode {
  const [edited, setEdited] = useState(false); // no hint while typing; it shows for a stored id, or after leaving the field
  const known = !value || (skills?.some((s) => s.id === value) ?? true);
  return (
    <label className="loop-field"><span>Skill</span>
      <input list="loop-skill-choices" value={value} placeholder="Pick a skill or type its id" aria-describedby="loop-skill-hint" onBlur={() => setEdited(false)} onChange={(e) => { setEdited(true); onChange(e.target.value); }} />
      <datalist id="loop-skill-choices">{(skills ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</datalist>
      {known || edited ? null : <small id="loop-skill-hint" className="loop-native-hint">This skill is not in your skill list; it is kept as it is.</small>}
    </label>
  );
}
