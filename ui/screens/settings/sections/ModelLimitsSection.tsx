// Settings home for the per-user model chain and caps (formerly only a modal on Auto Tasks).
import { ModelLimitsPanel } from "../../autotasks/native/ModelLimitsPanel.tsx";

export default function ModelLimitsSection() {
  return <ModelLimitsPanel embedded onClose={() => undefined} />;
}
