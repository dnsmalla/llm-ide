// The Composer wired to the slash menu, mentions, skill chips and attachments for one chat.
import { Composer, type ComposerProps } from "../Composer";
import { useComposerExtras, type ComposeServices, type ExtrasOptions } from "./extras";

export type ExtrasComposerProps = Omit<ComposerProps, "extras"> & { compose: ComposeServices } & Pick<ExtrasOptions, "models" | "setMode" | "setModel" | "clearChat" | "chatId" | "registry">;

export function ComposerWithExtras({ compose, models, setMode, setModel, clearChat, chatId, registry, ...rest }: ExtrasComposerProps) {
  const extras = useComposerExtras({ services: compose, draft: rest.draft, setDraft: rest.onDraft, models, setMode, setModel, clearChat, chatId, registry, busy: rest.busy });
  return <Composer {...rest} extras={extras} />;
}
