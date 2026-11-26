import { StatusBanner } from "./StatusBanner";

/** An error banner, or nothing when there is no text. */
export function ErrorText({ text }: { text: string | null }) {
  return text ? <StatusBanner severity="error" message={text} /> : null;
}
