// Native QR decoding via BarcodeDetector (no JS decoder is bundled: script-src 'self' and a minimal dependency surface).
interface Detected { rawValue: string }
interface Detector { detect(src: ImageBitmapSource): Promise<Detected[]> }
type DetectorCtor = new (o: { formats: string[] }) => Detector;

export const scannerSupport = (g: Record<string, unknown> = globalThis as never): boolean => typeof g["BarcodeDetector"] === "function";
export const cameraSupport = (): { ok: true } | { ok: false; reason: string } => {
  if (!globalThis.isSecureContext) return { ok: false, reason: "The camera needs a secure (https) page." };
  if (!navigator.mediaDevices?.getUserMedia) return { ok: false, reason: "This browser cannot open a camera." };
  return { ok: true };
};

export function createDetector(): Detector | null {
  const C = (globalThis as unknown as { BarcodeDetector?: DetectorCtor }).BarcodeDetector;
  return C ? new C({ formats: ["qr_code"] }) : null;
}

/** First QR text found in `src`, or null. */
export async function detectQr(det: Detector, src: ImageBitmapSource): Promise<string | null> {
  try { return (await det.detect(src))[0]?.rawValue ?? null; } catch { return null; }
}

export async function decodeFile(file: File): Promise<string | null> {
  const det = createDetector();
  if (!det || typeof createImageBitmap !== "function") return null;
  let bmp: ImageBitmap | null = null;
  try { bmp = await createImageBitmap(file); return await detectQr(det, bmp); } catch { return null; } finally { bmp?.close(); }
}

/** A user-facing reason for a getUserMedia failure. */
export function cameraError(e: unknown): string {
  const name = (e as { name?: string } | null)?.name;
  if (name === "NotAllowedError" || name === "SecurityError") return "Camera permission was denied.";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No camera was found on this device.";
  return "The camera could not be started.";
}
