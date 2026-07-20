# First-Time Setup & After Pull

## New Machine Setup

```bash
# 1. Clone the repo
git clone git@github.com:dnsmalla/llm-ide.git
cd llm-ide

# 2. Run setup (installs all dependencies)
./setup.sh

# 3. Start the Node server
cd extension && npm run server

# 4. In another terminal, build the macOS app
cd mac && swift build
```

---

## After `git pull` on any machine

**Always run setup if you pulled changes:**

```bash
./setup.sh
```

This ensures:
- ✅ Node dependencies installed (`npm install` in extension/)
- ✅ Native modules rebuilt (better-sqlite3, etc.)
- ✅ Claude CLI verified
- ✅ Git hooks enabled

---

## Why `npm install` is needed

- `node_modules/` is in `.gitignore` (correct practice)
- Only `package-lock.json` is committed
- `package-lock.json` tells `npm install` what exact versions to download
- Without running `npm install`, you get: **"module not found"** errors

---

## Quick Commands

| Task | Command |
|------|---------|
| Full setup | `./setup.sh` |
| Just install deps | `cd extension && npm install` |
| Start Node server | `cd extension && npm run server` |
| Build macOS app | `cd mac && swift build` |
| Run tests | `cd extension && npm test` |

---

## Common Errors After Pull

### ❌ "Cannot find module 'docx'"
→ Run `./setup.sh`

### ❌ "Cannot find module 'js-yaml'"  
→ Run `./setup.sh`

### ❌ "Server starts but gives 404 on routes"
→ Make sure Node server running: `cd extension && npm run server`

---

## Troubleshooting

If `./setup.sh` fails:

```bash
# Clean install
rm -rf extension/node_modules
npm ci --prefix extension     # Uses package-lock.json for exact versions

# Or use the full setup
./setup.sh --force
```
