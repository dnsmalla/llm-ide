// Renders a Preview as text only (never markup). Long blocks show their first lines and expand on request, so a
// queue of large tool arguments costs a few hundred characters per card until the user asks for more.
import { useState } from "react";
import { firstLines } from "./sanitize";
import { PREVIEW_COLLAPSED_CHARS, PREVIEW_COLLAPSED_LINES, PREVIEW_MAX_CHARS, type Block, type Preview } from "./preview";

function BlockView({ b }: { b: Block }) {
  const [open, setOpen] = useState(false);
  const lines = firstLines(b.text, PREVIEW_COLLAPSED_LINES);
  const tooLong = lines.more || b.text.length > PREVIEW_COLLAPSED_CHARS;
  const shown = open || !tooLong ? b.text : lines.text.slice(0, PREVIEW_COLLAPSED_CHARS);
  return (
    <div className="appr-block" data-tone={b.tone}>
      <div className="appr-caption">{b.caption}</div>
      {b.redactions > 0 && <p className="appr-warn" role="note">{b.redactions} {b.redactions === 1 ? "secret" : "secrets"} redacted: shown as [REDACTED], the real call still carries the original text.</p>}
      {b.hidden.length > 0 && <p className="appr-warn" role="note">Not shown: {b.hidden.join(", ")}.</p>}
      {(b.truncated || b.totalChars > PREVIEW_MAX_CHARS) && <p className="appr-warn" role="note">Only the first {PREVIEW_MAX_CHARS} of {b.totalChars} characters can be shown here; the call itself is longer.</p>}
      <pre className="appr-pre" tabIndex={0} aria-label={`${b.caption}, ${b.totalChars} characters`}>{shown}</pre>
      {tooLong && (
        <button type="button" className="chat-link-btn" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? "Show less" : `Show all (${lines.total} lines, ${b.totalChars} characters)`}
        </button>
      )}
      {b.hadHidden && <p className="appr-warn" role="note">This text contains hidden or control characters, shown as {"<U+XXXX>"} ({b.hiddenCount} found).</p>}
    </div>
  );
}

export function ArgsPreview({ preview }: { preview: Preview }) {
  switch (preview.kind) {
    case "none": return <p className="chat-muted">No arguments were sent with this request.</p>;
    case "diff":
      return (
        <div>
          {preview.file && <p className="appr-path">{preview.file.text}</p>}
          {preview.blocks.map((b) => <BlockView key={b.caption} b={b} />)}
          {preview.replaceAll && <p className="appr-warn">Replaces ALL occurrences in the file.</p>}
        </div>
      );
    case "write":
      return (
        <div>
          {preview.file && <p className="appr-path">{preview.file.text}</p>}
          <BlockView b={preview.block} />
          <p className="chat-muted">{preview.exists ? "Overwrites an existing file" : "Creates a new file"}{preview.totalChars !== null ? `, ${preview.totalChars} characters in total` : ""}. Only the start is shown.</p>
        </div>
      );
    default:
      return <BlockView b={preview.block} />;
  }
}
