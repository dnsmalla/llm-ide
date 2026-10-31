# graph-layout.wasm (vendored)

The Rust layout kernel of graph-kit (`mac/LocalPackages/graph-kit/rust/graph-layout`), built to plain wasm32
and committed here so the desktop app loads it from its own bundle (no network, no remote code). The
Code Graph screen runs it inside a Web Worker (`../worker/graph.worker.ts`) through the C ABI
(`../kernel.ts`).

| | |
|---|---|
| graph-kit commit | `51ff3721a7ac6621f23d0216064c0d04eaf35e9a` (`git -C mac/LocalPackages/graph-kit rev-parse HEAD`) |
| compiler | rustc 1.99.1 (58cf8f9c3 2026-10-13), target wasm32-unknown-unknown, release |
| build command | `cd mac/LocalPackages/graph-kit && CARGO_TARGET_DIR=<tmp> scripts/build-layout-wasm.sh <tmp-out>` |
| size | 106,429 bytes (40,053 gzip) |
| sha256 | `0f30028fe33b39c84a41a7c975d118b7402e6c50033bbe7d38358bc600d179a0` |

`MANIFEST.json` is the machine-readable form of this table. Two builds with the same compiler gave the same
bytes (checked when vendoring).

Note: the commit above is graph-kit `main` as checked out locally. The submodule pointer recorded in this
repository (`c0bcb6e4`) is older and does not contain the `graph-layout` crate yet; moving the pointer is a
separate step (`make graphkit-bump`, owned by the graph-kit workflow) and was not done here.

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
