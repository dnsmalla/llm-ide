# Run a remote project host

Phase 1 of remote projects lets a browser open, edit and save a text file in a project that lives on a server. The
project, git, the agent and the model keys stay on that server; the browser receives only the file it opens.

## 1. Prepare the server

```bash
# a project on the server
git clone <repo> /srv/projects/app
cd /srv/projects/app
mkdir -p system
printf '{"name":"app"}\n' > system/project.json

# a data directory owned by the service user
sudo install -d -o llmide -g llmide /var/lib/llmide
```

The core must run with its own data directory, never the repo's `kb/`:

```bash
LLMIDE_DATA_DIR=/var/lib/llmide node /opt/llmide/extension/server.mjs
```

Bind it to loopback and reach it through a tunnel or a TLS reverse proxy. Do not expose port 3456 directly.

## 2. Register the project on the host

The project id must exist in both the canonical registry and the user's project map. Use the authenticated
`POST /kb/projects/register` route (the desktop Settings path calls the same route):

```bash
curl -X POST http://127.0.0.1:3456/kb/projects/register \
  -H "authorization: Bearer $LLMIDE_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"root":"/srv/projects/app","name":"app"}'
```

A successful response has `{ "id": "...", "root": "/srv/projects/app", "name": "app" }`.

## 3. Pair a client

1. In the host Settings, enable the Host API and show the pairing PIN.
2. Open the web app, enter the host address and PIN.
3. Pick the project in the project picker.

The browser now has `read`; `files.list` and `files.read` work as before, and the new `files.stat` / `files.write` are
available.

## 4. Use the Workspace tab

1. Open **Workspace**.
2. Choose a file.
3. Edit and press **Save**.

A save sends `expectedHash` from the last stat. If another writer changed the file, the host answers
`conflict` and the client says to reload.

## 5. Acceptance checklist

Run each on the server and record the result:

- [ ] open a text file, change one line, Save → `git diff` shows exactly that line
- [ ] open the same file in a second browser, Save from both → second gets `conflict`
- [ ] save a path `../outside` → `invalid_payload`
- [ ] save `.git/config` → `denied`
- [ ] project viewer role → write refused
- [ ] file over 262,144 bytes → `invalid_payload`
- [ ] binary file → not opened as text
- [ ] audit row `file_write` has project, path and size, and no file text
- [ ] no repository clone or sync is created on the client

## Limits

- Text files only; no binary, rename, delete or mkdir UI.
- No git commit, terminal or Loop on the host yet.
- Desktop and iPhone are later phases; the web client is the first remote client.
- The model provider still receives the code sent to it; for licensed code use a self-hosted model or a no-training
  enterprise agreement.
