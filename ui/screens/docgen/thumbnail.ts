// Downsample a host image data URL for the sibling strip. The base64 bytes become a Blob directly: the app's CSP
// has no `data:` in connect-src, so fetching the data URL would always fall back to the full image. Only the small
// canvas result is retained; a failure falls back to the original URL rather than hiding the image.
export function dataUrlToBlob(url: string): Blob {
  const comma = url.indexOf(",");
  const meta = comma >= 0 ? url.slice(0, comma) : "";
  const mime = /^data:([^;,]+)/.exec(meta)?.[1] ?? "application/octet-stream";
  const body = comma >= 0 ? url.slice(comma + 1) : "";
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

export async function shrinkDataUrl(url: string, max = 192): Promise<string> {
  try {
    const bitmap = await createImageBitmap(dataUrlToBlob(url));
    const scale = Math.min(1, max / Math.max(1, bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return url;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    return canvas.toDataURL("image/png");
  } catch {
    return url;
  }
}
