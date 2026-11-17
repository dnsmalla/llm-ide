// Board header "Final review" toggle. system/factory-template.json stays the single source of truth: the toggle reads
// and writes it through the same read/parse/format path as the Process tab, so the two can never disagree.
import type { FsApi } from "../explorer/fs";
import { TEMPLATE_FILE, formatFactoryTemplate, parseFactoryTemplate, readTemplateFile } from "../loop/native/factory-template.ts";

/** null when the template is missing or invalid: the toggle then has nothing safe to show or change. */
export async function readReviewMode(fs: Pick<FsApi, "read">): Promise<"auto" | "human" | null> {
  const file = await readTemplateFile(fs);
  if (file.kind === "missing" || !file.parse.ok) return null;
  return file.parse.template.reviewMode === "human" ? "human" : "auto";
}

export async function writeReviewMode(fs: Pick<FsApi, "read" | "write">, mode: "auto" | "human"): Promise<{ ok: true } | { ok: false; message: string }> {
  // A read error is reported, not thrown: the caller is a click handler with nobody to catch it.
  let file: Awaited<ReturnType<typeof readTemplateFile>>;
  try {
    file = await readTemplateFile(fs);
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
  if (file.kind === "missing") return { ok: false, message: "The Factory process file does not exist yet. Open Process once to create it." };
  const parsed = file.parse.ok ? file.parse : parseFactoryTemplate(file.text);
  if (!parsed.ok) return { ok: false, message: "The Factory process has problems; fix them in Process first." };
  // Auto means the key is absent (the file stays minimal), so remove it rather than write "auto".
  const next = { ...parsed.template };
  if (mode === "human") next.reviewMode = "human";
  else delete next.reviewMode;
  // expected_hash makes a concurrent Process-tab save win instead of being overwritten.
  try {
    await fs.write(TEMPLATE_FILE, formatFactoryTemplate(next), { expected_hash: file.hash });
  } catch (e) {
    const code = typeof e === "object" && e !== null ? (e as { code?: unknown }).code : undefined;
    return { ok: false, message: code === "conflict" ? "The file changed on disk; try again." : e instanceof Error ? e.message : String(e) };
  }
  return { ok: true };
}
