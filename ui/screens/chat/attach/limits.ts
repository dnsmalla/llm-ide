// Limits shared by the attachment pipeline. Host side (desktop/src-tauri/src/attach.rs): 25 MB per file, 100 MB of
// live handles, 64 handles, 20 per pick, reads of at most 4 MiB. Core side (extension/core/prompt-framing.mjs,
// POST /agent/v2/stream): 30 files, 80,000 characters per text file, 200,000 in total, images only png/jpeg/gif/
// webp up to 6,000,000 base64 characters each, 8 per turn, 14,000,000 in total.
export const HOST_CHUNK_BYTES = 4 * 1024 * 1024;
export const HOST_FILE_MAX_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENTS = 30;
export const MAX_TEXT_CHARS_PER_FILE = 80_000;
export const MAX_TEXT_CHARS_TOTAL = 200_000;
/** Enough bytes for MAX_TEXT_CHARS_PER_FILE characters even at 4 bytes each; the rest of a big file is never read. */
export const TEXT_READ_BYTES = MAX_TEXT_CHARS_PER_FILE * 4;
export const MAX_IMAGES = 8;
export const MAX_IMAGE_BASE64_CHARS = 6_000_000;
export const MAX_IMAGES_TOTAL_BASE64_CHARS = 14_000_000;
/** Raw bytes whose base64 form still fits one image. */
export const MAX_IMAGE_BYTES = Math.floor((MAX_IMAGE_BASE64_CHARS / 4) * 3);
export const IMAGE_MIMES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
