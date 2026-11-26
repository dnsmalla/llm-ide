// "One item I name": the person's one-line task for this run, told to the agent on every prompt of the run.
export const RUN_COMMAND_MAX = 2000;

/**
 * True when the run is a one-item run. A task typed on a board (or workMode "one") narrows the run to that item even
 * when the loop is configured for "all"; a Factory run is never one-item (it has its own picked work item).
 * `isFactory` is passed in so this module stays free of the heavy factory.ts imports.
 */
export function isOneItemRun(workMode: string | undefined, command: string | undefined, isFactory: boolean): boolean {
  return !isFactory && (workMode === "one" || !!command?.trim());
}

/** The prompt lines for the run's command; empty when there is none. The one place the wording lives. */
export function runCommandLines(text: string | undefined): string[] {
  const t = text?.trim();
  return t ? [`This run's task, given by the user: ${t}`, "Do only this one item and then stop. Do not pick any other item."] : [];
}
