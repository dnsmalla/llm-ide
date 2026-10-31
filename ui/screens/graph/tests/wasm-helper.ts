import { readFileSync } from "node:fs";

export const WASM_PATH = new URL("../wasm/graph-layout.wasm", import.meta.url);
export const loadWasmBytes = async (): Promise<BufferSource> => new Uint8Array(readFileSync(WASM_PATH));
