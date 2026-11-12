// The Factory board's lanes: Backlog, one lane per process step (numbered, in order), then Done. Presentational only:
// the Board owns the data and the card callbacks, so the same markup renders in the app and in a static fixture.
import type { KeyboardEvent, ReactNode } from "react";
import { LANE_BACKLOG, LANE_DONE, type CardView, type Lane } from "./board-model.ts";

const emptyCopy = (lane: string): string => (lane === LANE_BACKLOG ? "No open issues or work items" : lane === LANE_DONE ? "Nothing waiting to merge" : "Nothing at this step");
const kindOf = (lane: string): "backlog" | "done" | "step" => (lane === LANE_BACKLOG ? "backlog" : lane === LANE_DONE ? "done" : "step");

export function LaneBoard({ lanes, renderCard, onKeyDown }: {
  lanes: readonly Lane[];
  renderCard: (view: CardView) => ReactNode;
  onKeyDown?: (e: KeyboardEvent<HTMLDivElement>) => void;
}): ReactNode {
  let step = 0;
  return (
    <div className="fx-board" role="region" aria-label="Factory board" onKeyDown={onKeyDown}>
      {lanes.map((lane) => {
        const kind = kindOf(lane.id);
        const n = kind === "step" ? ++step : null;
        const running = lane.cards.some((c) => c.status === "Working");
        return (
          <section key={lane.id} className="fx-col" data-kind={kind} data-running={running || undefined} role="group" aria-label={`${lane.label} (${lane.cards.length})`}>
            <h3 className="fx-col-title">
              <span className="fx-col-step" aria-hidden="true">{n ?? (kind === "done" ? "✓" : "•")}</span>
              <span className="fx-col-name">{lane.label}</span>
              <span className="fx-col-count">{lane.cards.length}</span>
            </h3>
            <ul className="fx-cards" role="list" aria-label={`${lane.label} cards`}>
              {lane.cards.map(renderCard)}
            </ul>
            {lane.cards.length === 0 ? <p className="fx-col-empty">{emptyCopy(lane.id)}</p> : null}
          </section>
        );
      })}
    </div>
  );
}
