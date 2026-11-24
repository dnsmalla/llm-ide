import { pickerIssues, type PickerIssue } from "../loop/native/factory.ts";

type Request = (path: string) => Promise<{ status: number; body: unknown }>;

/** One provider's open issues, by offset (the core caps a page at 100), up to 10 pages. `failed`: a page errored, so the list is partial. */
export async function walkOpenIssues(request: Request, provider: string, signal?: AbortSignal): Promise<{ issues: PickerIssue[]; failed: boolean }> {
  const issues: PickerIssue[] = [];
  for (let page = 0; page < 10; page++) {
    if (signal?.aborted) break;
    const r = await request(`/kb/issues?provider=${provider}&state=open&limit=100&offset=${page * 100}`).catch(() => null);
    if (signal?.aborted) break;
    if (r?.status !== 200) return { issues, failed: true };
    const rows = (r.body as { issues?: unknown[] } | null)?.issues;
    issues.push(...pickerIssues(r.body));
    if (!Array.isArray(rows) || rows.length < 100) break;
  }
  return { issues, failed: false };
}
