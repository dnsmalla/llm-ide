# graph-layout.wasm (vendored)

The Rust layout kernel of graph-kit (`graph-kit/rust/graph-layout`), built to plain wasm32
and committed here so the desktop app loads it from its own bundle (no network, no remote code). The
Code Graph screen runs it inside a Web Worker (`../worker/graph.worker.ts`) through the C ABI
(`../kernel.ts`).

| | |
|---|---|
| graph-kit commit | `6de363ff6789c223da4b0d3cad164c0abad1ff32` (`git -C graph-kit rev-parse HEAD`) |
| compiler | rustc 1.99.1 (58cf8f9c3 2026-10-13), target wasm32-unknown-unknown, release |
| build command | `cd graph-kit && CARGO_TARGET_DIR=<tmp> scripts/build-layout-wasm.sh <tmp-out>` |
| size | 106,575 bytes (40,114 gzip) |
| sha256 | `b0d7eae260c09eb06daf8b39694bfd6163c958487931c720f464a5d31f9a981e` |

`MANIFEST.json` is the machine-readable form of this table. Two builds with the same compiler gave the same
bytes (checked when vendoring).

The commit above is the pinned graph-kit commit (the submodule pointer of `graph-kit/`, bumped by
`make graphkit-bump` in `263aff4e`) and is on graph-kit's
`origin/main`, so the file can be rebuilt and checked from public sources. Re-vendor after every bump that
touches `rust/graph-layout`.

## Re-vendor and verify

```bash
node scripts/vendor-graph-layout-wasm.mjs            # rebuild from the graph-kit checkout, copy, rewrite the manifest
node scripts/vendor-graph-layout-wasm.mjs --from f   # vendor a prebuilt file
node scripts/vendor-graph-layout-wasm.mjs --verify   # committed file vs committed manifest (also run by the tests)
```

The build needs the rust toolchain (`~/.rustup/toolchains/stable-aarch64-apple-darwin/bin` on PATH) with the
`wasm32-unknown-unknown` target. The script reads graph-kit and builds into a temporary directory: it never
writes inside the submodule, never commits there and never moves the pin.

## Kernel contract (summary; full text in graph-kit's README)

Input: `u32 n | u32 m | u8 kindCount | kinds (u8 len, utf8) | m x (u32 from, u32 to, u8 kind, u8 confidence)`.
Output: `u32 n | u32 links | u32 communities | n x (f64 x, f64 y, f64 radius, u32 community, u32 degree, u32 inDegree) | links x f64 weight`.
The kernel has no cancellation point (one blocking call), so cancel means terminating the worker.
