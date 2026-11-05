// Downsample a host image data URL for the sibling strip. The full-resolution image is decoded once, drawn to a
// small canvas, and only the small JPEG is retained; a failure falls back to the original URL rather than hiding it.
export async function shrinkDataUrl(url: string, max = 192): Promise<string> {
  try {
    const blob = await (await fetch(url)).blob();
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, max / Math.max(1, bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return url;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    return canvas.toDataURL("image/jpeg", 0.82);
  } catch {
    return url;
  }
}
