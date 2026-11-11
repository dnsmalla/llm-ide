// Visual → Media studio (demo provider). The desktop core has no image/video provider yet, so this runs a local,
// zero-cost generator to verify the prompt → preview → download flow and the model picker. Real providers slot in
// behind the same two model ids later; nothing here calls the network.
import { useState, type ReactNode } from "react";

export type MediaKind = "image" | "video";
export const MEDIA_MODELS: readonly { id: string; kind: MediaKind; label: string }[] = [
  { id: "demo-image-1", kind: "image", label: "Demo Image 1 (local)" },
  { id: "demo-video-1", kind: "video", label: "Demo Video 1 (local)" },
];

const escapeXml = (s: string): string => s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c]!));

function wrap(text: string, width = 52): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    let current = "";
    for (const word of line.split(/\s+/)) {
      if ((current + " " + word).trim().length > width) { if (current) out.push(current); current = word; }
      else current = (current + " " + word).trim();
    }
    if (current) out.push(current);
  }
  return out.slice(0, 6);
}

/** One deterministic local image: a token-coloured poster with the prompt. */
export function demoImage(prompt: string): string {
  const lines = wrap(prompt);
  const text = lines.map((l, i) => `<text x="512" y="${360 + i * 34}" text-anchor="middle" font-family="system-ui,sans-serif" font-size="26" fill="#e9edf7">${escapeXml(l)}</text>`).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#266b82"/><stop offset="0.55" stop-color="#40548f"/><stop offset="1" stop-color="#8a4b8f"/></linearGradient></defs><rect width="1024" height="1024" fill="url(#g)"/><circle cx="790" cy="230" r="220" fill="#ffffff" fill-opacity="0.10"/><circle cx="250" cy="760" r="300" fill="#000000" fill-opacity="0.12"/><text x="512" y="280" text-anchor="middle" font-family="system-ui,sans-serif" font-size="20" letter-spacing="4" fill="#d8e3ef">DEMO IMAGE</text>${text}</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** One deterministic local "video": an animated SVG poster, so the job/preview UI can be tested without a media API. */
export function demoVideo(prompt: string): string {
  const lines = wrap(prompt);
  const text = lines.map((l, i) => `<text x="512" y="${430 + i * 30}" text-anchor="middle" font-family="system-ui,sans-serif" font-size="22" fill="#e9edf7">${escapeXml(l)}</text>`).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="576" viewBox="0 0 1024 576"><defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#18202f"/><stop offset="1" stop-color="#2a3550"/></linearGradient></defs><rect width="1024" height="576" fill="url(#bg)"/><circle r="70" fill="#62d6a3" fill-opacity="0.9"><animate attributeName="cx" values="180;844;180" dur="6s" repeatCount="indefinite"/><animate attributeName="cy" values="300;210;300" dur="6s" repeatCount="indefinite"/></circle><circle r="26" fill="#8fb3ff"><animate attributeName="cx" values="844;180;844" dur="6s" repeatCount="indefinite"/><animate attributeName="cy" values="160;420;160" dur="6s" repeatCount="indefinite"/></circle><text x="512" y="96" text-anchor="middle" font-family="system-ui,sans-serif" font-size="18" letter-spacing="4" fill="#9fb0c9">DEMO VIDEO · 6s · LOOP</text>${text}</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export function MediaStudio(): ReactNode {
  const [kind, setKind] = useState<MediaKind>("image");
  const [model, setModel] = useState(MEDIA_MODELS[0]!.id);
  const [prompt, setPrompt] = useState("");
  const [result, setResult] = useState<{ kind: MediaKind; url: string; prompt: string } | null>(null);
  const models = MEDIA_MODELS.filter((m) => m.kind === kind);
  const generate = () => {
    const text = prompt.trim();
    if (!text) return;
    const url = kind === "image" ? demoImage(text) : demoVideo(text);
    setResult({ kind, url, prompt: text });
  };
  return (
    <section className="dg-media" aria-label="Media studio">
      <header className="dg-media-head">
        <h2>Media studio</h2>
        <span className="dg-muted">Demo provider · no API key, no cost</span>
      </header>
      <div className="dg-media-controls">
        <div className="dg-seg" role="group" aria-label="Media kind">
          {(["image", "video"] as const).map((k) => <button key={k} type="button" className="dg-tab" aria-pressed={kind === k} onClick={() => { setKind(k); setModel(MEDIA_MODELS.find((m) => m.kind === k)!.id); }}>{k === "image" ? "Image" : "Video"}</button>)}
        </div>
        <label className="dg-field"><span>Model</span><select value={model} onChange={(e) => setModel(e.target.value)}>{models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</select></label>
        <label className="dg-field dg-grow"><span>Prompt</span><input value={prompt} maxLength={800} placeholder="A calm architecture diagram for the auth service" onChange={(e) => setPrompt(e.target.value)} /></label>
        <button type="button" className="dg-btn dg-primary" disabled={!prompt.trim()} onClick={generate}>Generate {kind}</button>
      </div>
      {result ? (
        <figure className="dg-media-result">
          <img src={result.url} alt={`${result.kind}: ${result.prompt}`} />
          <figcaption>
            <span>{result.kind === "image" ? "1024×1024" : "1024×576 · 6s loop"} · {model}</span>
            <a className="dg-btn" href={result.url} download={result.kind === "image" ? "demo-image.svg" : "demo-video.svg"}>Download</a>
          </figcaption>
        </figure>
      ) : <p className="dg-muted">Generate a local demo image or animated poster to check the flow. Real providers are not connected yet.</p>}
    </section>
  );
}
