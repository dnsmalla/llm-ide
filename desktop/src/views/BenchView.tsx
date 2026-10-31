import { useMemo, useSyncExternalStore } from "react";
import "./bench.css";
import { getRecords, subscribeRecords } from "../bench/records";
import { ALL_STEPS, getRunState, runSteps, subscribeRunState } from "../bench/runner";
import { buildRows, type BenchRow } from "../bench/targets";
import { StatusBanner } from "@llmide/ui-kit";

/** Bench tab: runs every bench in turn and shows the results against the §6 targets. */
export function BenchView() {
  const records = useSyncExternalStore(subscribeRecords, getRecords);
  const run = useSyncExternalStore(subscribeRunState, getRunState);
  const rows = useMemo(() => buildRows(records), [records]);
  const counts = useMemo(() => {
    const c = { pass: 0, fail: 0, info: 0 };
    for (const r of rows) c[r.verdict] += 1;
    return c;
  }, [rows]);

  const progress = run.running
    ? run.step
      ? `running ${run.step} (${run.done + 1} of ${run.total})…`
      : "starting…"
    : null;

  return (
    <section className="bench-view">
      <header className="bench-bar">
        <span className="bench-title">Bench</span>
        <span className="bench-meta">{progress ?? `${ALL_STEPS.length} steps: ${ALL_STEPS.join(" · ")}`}</span>
        <span className="bench-spacer" />
        <button type="button" className="bench-run" disabled={run.running} onClick={() => void runSteps(ALL_STEPS, false)}>
          Run all
        </button>
      </header>
      <div className="bench-body">
        {rows.length === 0 ? (
          <div className="bench-empty">
            Run all measures the code graph, editor, terminal and chat benches in turn, then the macOS accessibility probe.
            The app switches tabs while it runs.
          </div>
        ) : (
          <>
            <StatusBanner
              severity={counts.fail > 0 ? "error" : "info"}
              message={`${counts.pass} pass · ${counts.fail} fail · ${counts.info} info`}
            />
            <table className="bench-table">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Value</th>
                  <th scope="col">Unit</th>
                  <th scope="col">Target</th>
                  <th scope="col">Result</th>
                  <th scope="col">Detail</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <BenchTableRow key={r.name} row={r} />
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    </section>
  );
}

function BenchTableRow({ row }: { row: BenchRow }) {
  return (
    <tr>
      <td className="bench-name">{row.name}</td>
      <td className="bench-num">{row.value}</td>
      <td>{row.unit}</td>
      <td>{row.target}</td>
      <td>
        <span className="bench-verdict" data-verdict={row.verdict}>
          {row.verdict}
        </span>
      </td>
      <td className="bench-detail" title={row.detail}>
        {row.detail}
      </td>
    </tr>
  );
}
