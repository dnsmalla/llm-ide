import MemorySection from "./MemorySection.tsx";
import CodeGraphSection from "./CodeGraphSection.tsx";

/** Project memory and its graph are one surface: what exists, and when the host refreshes it. */
export default function MemoryGroup() {
  return (
    <div className="st-stack">
      <MemorySection />
      <div className="st-stack"><span className="st-label">Graph refresh</span><CodeGraphSection /></div>
    </div>
  );
}
