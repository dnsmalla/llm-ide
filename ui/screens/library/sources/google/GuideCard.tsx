import type { ReactNode } from "react";
import type * as E from "./easy.ts";

export function GuideCard({ guide, notes }: { guide: E.Guide; notes: readonly string[] }): ReactNode {
  return (
    <>
      <h4>{guide.title}</h4>
      <ol aria-label={`${guide.title}: steps`}>
        {guide.steps.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>
      <ul aria-label={`${guide.title}: good to know`}>
        {notes.map((n) => (
          <li key={n} className="lib-muted">
            {n}
          </li>
        ))}
      </ul>
    </>
  );
}
