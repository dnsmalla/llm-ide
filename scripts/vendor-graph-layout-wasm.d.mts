export const WASM_DIR: string;
export const WASM_FILE: string;
export const MANIFEST_FILE: string;
export const BUILD_COMMAND: string;
export function sha256(buf: Uint8Array): string;
/** Problems with the committed wasm vs its manifest (empty = verified). */
export function verify(wasmFile?: string, manifestFile?: string): string[];
