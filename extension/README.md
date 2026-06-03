# Meet Notes — Extension + Server

Chrome side-panel extension and local Node server. Full engineering docs: <SITE_URL>.

## Quick start

```bash
cd extension
npm install
npm run server          # node server.mjs (127.0.0.1:3456)
npm run build           # produce dist/ for unpacked Chrome load
```

## Scripts

| Script | What it does |
|---|---|
| `npm run server` | Start the local API |
| `npm run dev` | Vite dev server with HMR |
| `npm run build` | Type-check + production build to `dist/` |
| `npm run type-check` | `tsc --noEmit` |
| `npm test` | `node --test tests/*.test.mjs` |

## See also

- [Top-level README](../README.md)
- [How to run the server locally](../docs/how-to/run-the-server-locally.md)
- [How to add a new endpoint](../docs/how-to/add-an-endpoint.md)
- [Engineering invariants](../docs/explanation/invariants.md)
