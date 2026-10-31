// Doc Gen section entry: the shell lazy-loads this module (default export, SectionProps).
import type { SectionProps } from "@llmide/screens/shell";
import { GenerationSection } from "./section";

export { DocGenScreen, type DocGenScreenProps } from "./DocGenScreen";
export { DocGenStore } from "./store.ts";

export default function DocGen(props: SectionProps) {
  return <GenerationSection {...props} surface="doc" />;
}
