import RoutingSection from "./RoutingSection.tsx";
import ModelLimitsSection from "./ModelLimitsSection.tsx";

/** Models, routes and their caps are one place: routing chooses, limits bound it. */
export default function ModelsGroup() {
  return (
    <div className="st-stack">
      <RoutingSection />
      <div className="st-stack">
        <span className="st-label">Per-model limits</span>
        <ModelLimitsSection />
      </div>
    </div>
  );
}
