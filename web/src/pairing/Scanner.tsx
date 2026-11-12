import "./pairing.css";
import { useEffect, useRef, useState, type RefObject } from "react";
import { Banner, Button, Sheet, TextField } from "../ui/index.ts";
import { parsePairingLink, type PairingOffer } from "./qr.ts";
import { cameraError, cameraSupport, createDetector, decodeFile, detectQr, scannerSupport } from "./scan.ts";

export type ScanMode = "starting" | "scanning" | "unavailable";

export interface ScanViewProps {
  mode: ScanMode;
  notice: string | null; // why the camera is off (denied, none, insecure, unsupported)
  problem: string | null; // the last code or photo was not a pairing link
  videoRef?: RefObject<HTMLVideoElement | null>;
  canDecodePhoto: boolean;
  onPhoto: (file: File) => void;
  onPaste: (text: string) => void;
}

/** What the scan sheet shows; presentational so the gallery can render each state without a camera. */
export function ScanView({ mode, notice, problem, videoRef, canDecodePhoto, onPhoto, onPaste }: ScanViewProps) {
  const [text, setText] = useState("");
  return (
    <>
      {mode !== "unavailable" && (
        <div className="pair-cam">
          <video ref={videoRef} muted playsInline aria-label="Camera preview" />
          <span className="pair-frame" aria-hidden="true" />
          <p className="web-muted">{mode === "starting" ? "Starting the camera…" : "Point the camera at the QR code on your desktop (Settings → Host API pairing)."}</p>
        </div>
      )}
      {notice && <Banner tone="warn" title={mode === "unavailable" ? "Scanning is not available" : "Camera problem"}>{notice} Paste the pairing link instead.</Banner>}
      {problem && <Banner tone="error">{problem}</Banner>}
      {canDecodePhoto && (
        <label className="pair-photo ui-btn" data-variant="secondary" data-size="md">
          Choose a photo of the QR
          <input type="file" accept="image/*" capture="environment" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) onPhoto(f); e.target.value = ""; }} />
        </label>
      )}
      <form className="web-stack" onSubmit={(e) => { e.preventDefault(); onPaste(text); }}>
        <TextField label="Paste the pairing link" value={text} onChange={(e) => setText(e.target.value)} placeholder="llmide://pair?…" autoComplete="off" spellCheck={false} inputMode="url"
          hint="On the desktop, copy the link shown under the QR code." />
        <Button type="submit" disabled={text.trim() === ""}>Use this link</Button>
      </form>
    </>
  );
}

/** The scan sheet: camera while open (tracks always stopped on close or unmount), BarcodeDetector decoding, paste fallback. */
export function ScanSheet({ open, onClose, onOffer }: { open: boolean; onClose: () => void; onOffer: (o: PairingOffer) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [mode, setMode] = useState<ScanMode>("starting");
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const supported = scannerSupport();
  const offer = useRef(onOffer);
  offer.current = onOffer;
  const accept = (text: string | null, what: string) => {
    const o = text === null ? null : parsePairingLink(text);
    if (o) { setProblem(null); offer.current(o); } else setProblem(text === null ? `No QR code was found in ${what}.` : "That is not an LLM-IDE pairing code.");
    return o !== null;
  };

  useEffect(() => {
    if (!open) return undefined;
    setProblem(null); setNotice(null); setMode("starting");
    const cam = cameraSupport();
    const det = createDetector();
    if (!cam.ok || !det) { setMode("unavailable"); setNotice(!cam.ok ? cam.reason : "This browser cannot read QR codes from the camera."); return undefined; }
    let stopped = false;
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => { stopped = true; if (timer) clearTimeout(timer); stream?.getTracks().forEach((t) => t.stop()); stream = null; };
    const tick = async () => {
      const v = video.current;
      if (stopped || !v) return;
      if (v.readyState >= 2) {
        const text = await detectQr(det, v);
        if (stopped) return;
        if (text !== null) { const o = parsePairingLink(text); if (o) { stop(); offer.current(o); return; } setProblem("That is not an LLM-IDE pairing code."); }
      }
      timer = setTimeout(() => void tick(), 250);
    };
    navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false }).then(async (s) => {
      if (stopped) { s.getTracks().forEach((t) => t.stop()); return; }
      stream = s;
      const v = video.current;
      if (!v) { stop(); return; }
      v.srcObject = s;
      try { await v.play(); } catch { /* autoplay refusal still leaves frames for the detector */ }
      setMode("scanning");
      void tick();
    }, (e: unknown) => { if (!stopped) { setMode("unavailable"); setNotice(cameraError(e)); } });
    return stop;
  }, [open]);

  return (
    <Sheet open={open} onClose={onClose} title="Scan the pairing QR">
      <ScanView mode={mode} notice={notice} problem={problem} videoRef={video} canDecodePhoto={supported}
        onPhoto={(f) => { void decodeFile(f).then((t) => accept(t, "that photo")); }} onPaste={(t) => accept(t, "that text")} />
    </Sheet>
  );
}
