// "One item I name": the person's one-line task for this run, told to the agent on every prompt of the run.
export const RUN_COMMAND_MAX = 2000;

/** The prompt lines for the run's command; empty when there is none. The one place the wording lives. */
export function runCommandLines(text: string | undefined): string[] {
  const t = text?.trim();
  return t ? [`This run's task, given by the user: ${t}`, "Do only this one item and then stop. Do not pick any other item."] : [];
}
