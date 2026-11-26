// Live, click-through tours: the same recipes help.ts explains in text, walked step by step on the real screen.
import type { TourFlow } from "../shell/tour-model";

export const DESKTOP_TOURS: readonly TourFlow[] = [
  {
    id: "recipe-issue",
    title: "Issue → shipped change",
    steps: [
      { id: "open-issue", title: "Open an issue", body: "Click any issue card to open its details.", targetId: "issue-card", screenId: "issues" },
      { id: "send-to-factory", title: "Send it to Factory", body: "This puts the issue in Factory's Backlog, ready to run.", targetId: "send-to-factory", screenId: "issues" },
      { id: "backlog", title: "It lands in Backlog", body: "Factory — the Loop board — picks it up here.", targetId: "lane-backlog", screenId: "conflicts" },
      { id: "start", title: "Click Start", body: "The AI plans the change, then implements, tests and reviews it, each one a step in this row.", targetId: "card-action-start", screenId: "conflicts" },
      { id: "done", title: "Reaches Done — open the draft MR", body: "A draft merge request is opened for you. Review it, then merge.", targetId: "done-mr-link", screenId: "conflicts" },
    ],
  },
];
