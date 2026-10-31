import AboutSection from "./AboutSection.tsx";
import { PartialNote } from "./NoticeSections.tsx";

/** The Mac's "Updates & About" group: version and diagnostics (About), with a note for the Mac-only update checks. */
export default function UpdatesSection() {
  return (
    <div className="st-stack">
      <AboutSection />
      <PartialNote id="updates" />
    </div>
  );
}
