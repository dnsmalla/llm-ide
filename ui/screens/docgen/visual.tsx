// Visual section entry (same screen, the "visual" templates and commands). Loaded through the shell's section map.
import type { SectionProps } from "@llmide/screens/shell";
import { GenerationSection } from "./section";

export default function Visual(props: SectionProps) {
  return <GenerationSection {...props} surface="visual" />;
}
