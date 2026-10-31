// The Mac's "Steps to generate" checklist (DocGenEditorPanel / VisualCenterPanel): three positional rows, each
// struck through once done. Step 3 is never "done" while the setup view is shown — the Mac hardcodes done: false —
// so the checklist marks preparation, not the result.
export interface ChecklistStep {
  title: string;
  detail: string;
  done: boolean;
}

export function checklistSteps(
  surface: "doc" | "visual",
  hasTemplateOrCommand: boolean,
  sourceCount: number,
): ChecklistStep[] {
  return [
    {
      title: "Choose a template or command",
      detail: "Pick either one in the Template & Command section on the left — optional with Use chat on",
      done: hasTemplateOrCommand,
    },
    surface === "visual"
      ? {
          title: "Select files from Data or Code",
          detail: "Tick a file's checkbox to use it as a source; tapping its NAME previews it — still required even with Use chat on",
          done: sourceCount > 0,
        }
      : {
          title: "Select code or doc files or folders",
          detail: "Tick files, or a whole folder, in the Sources section on the left",
          done: sourceCount > 0,
        },
    {
      title: "Add a prompt and generate",
      detail: "Write a short prompt in the panel on the right, then press Generate",
      done: false,
    },
  ];
}
