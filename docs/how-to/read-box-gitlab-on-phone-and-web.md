# Read Box documents and GitLab code on the iPhone and the web app

With the desktop off, the LLM-IDE iPhone app and web app can read your documents in Box and your code on gitlab.com
directly: browse, open one file read-only, and search. They use your own provider logins with read-only access.
Nothing is copied through sync and nothing read is stored on the device. Design: spec §9; plan
docs/superpowers/plans/2026-11-06-sync-sp7-direct-reads.md.

## GitLab (gitlab.com)

1. On gitlab.com: avatar → Preferences → Applications → Add new application.
2. Name: `LLM-IDE reader`. Untick **Confidential**. Tick only **read_api** and **read_repository**.
3. Redirect URIs, one per line (add the ones you use):
   - web: `https://llm-ide.com/app/oauth-callback.html` (your site) and, for development, `http://127.0.0.1:5180/oauth-callback.html`
   - iPhone: `llmide-oauth://gitlab/callback`
4. Save, copy the **Application ID** (there is no secret to copy for a non-confidential app), and paste it into
   the web app (Documents and code → GitLab code → App settings) or the iPhone app (Settings → Box and GitLab).
5. Sign in. A sign-in lasts for the browser session on the web, and on the iPhone until you sign out.

Self-hosted GitLab is not supported yet (decision D1).

## Box

1. In the Box developer console: Create New App → Custom App → **User Authentication (OAuth 2.0)**.
2. Application scopes: tick only **Read all files and folders stored in Box**. Leave everything else off.
3. Redirect URIs: `https://llm-ide.com/app/oauth-callback.html` (web), `http://127.0.0.1:5180/oauth-callback.html`
   (development), and `llmide-oauth://box/callback` (iPhone). If the console refuses the `llmide-oauth://` URI, the
   iPhone cannot sign in to Box yet (decision D9).
4. **CORS Domains** (web only): `https://llm-ide.com` and, for development, `http://127.0.0.1:5180`. Without them,
   Box refuses every call from the web app.
5. Copy the Client ID and Client Secret into the app. Box requires the secret for sign-in (it documents no PKCE). It
   is your own app's secret and is kept in this browser's IndexedDB or the iPhone Keychain. Anyone who controls
   script on the LLM-IDE site could read it, so revoke it in the Box console if you suspect that.
6. Sign in. Box shows a consent screen asking for read access only.

Box refresh tokens are single use and last 60 days. After 60 days without use, sign in again.

## What is shown

| File | Shown as |
|---|---|
| Code, config, text, HTML, SVG | plain text (source, never rendered), up to 1 MiB |
| Markdown | web: formatted, without HTML or images; iPhone: source text |
| PDF | iPhone: in the app (PDFKit, links disabled); web: **Save PDF** only |
| Word, Excel, PowerPoint and similar (Box) | the text Box extracts, up to 2 MiB |
| Images, archives, media, binaries | not shown; use "Open on Box/GitLab" |

## Revoke

- GitLab: Preferences → Applications → Authorized applications → Revoke.
- Box: Account settings → Apps → revoke the app, or remove it in the developer console.
- In LLM-IDE: **Sign out** revokes the token; **Forget app settings** also deletes the IDs and the Box secret.

## Manual check (iPhone)

- [ ] Settings → Box and GitLab: save the GitLab ID, **Sign in to GitLab**. The system sign-in sheet shows
      gitlab.com and asks for `read_api` and `read_repository`. Closing the sheet shows no error.
- [ ] With the desktop unreachable, History → At the source → GitLab code: projects, a folder, a `.swift` file
      (monospaced, selectable, larger with a larger text size), a `.png` (not shown), search inside a project.
- [ ] Box: a `.pdf` opens in the app and a link in it does nothing; a `.docx` shows extracted text.
- [ ] Airplane mode: opening a folder says "You are offline…".
- [ ] VoiceOver reads each row as "name, Folder/File" with the hint, and the file body as "Contents of …".
- [ ] Remove sync from this iPhone (Settings → Sync): the Box/GitLab sign-ins stay.
