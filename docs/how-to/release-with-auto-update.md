---
title: How to ship a release with Sparkle auto-update
applies_to: mac
---

# How to ship a release with Sparkle auto-update

The Mac app uses [Sparkle](https://sparkle-project.org/) to deliver
in-app updates. Once the appcast is hosted, every shipped client polls
it daily, prompts on a new version, downloads + verifies + installs
without you having to push DMGs by hand.

## One-time setup

### 1. Generate the EdDSA signing key pair

Sparkle ships `generate_keys` (and the matching `sign_update`) inside
its SPM binary artefact. After the first `swift package resolve` you
can run:

```bash
cd mac
SIGN_TOOL=$(find .build/artifacts -name 'sign_update' -type f -perm -u+x | head -1)
TOOL_DIR=$(dirname "$SIGN_TOOL")
"$TOOL_DIR/generate_keys"
```

Output:

```
A key has been generated and saved in your keychain. The public key is:
<base64-public-key>
```

The **private key** is now in your macOS Keychain under the item name
`Private key for signing Sparkle updates`. The **public key** is what
you embed in every shipped binary so clients can verify downloads.

Export the private key to a file so `appcast.sh` can read it:

```bash
mkdir -p ~/.meetnotes
chmod 700 ~/.meetnotes
security find-generic-password -ga "Private key for signing Sparkle updates" 2>&1 \
  | awk -F'"' '/password:/ {print $2}' > ~/.meetnotes/sparkle_ed25519
chmod 600 ~/.meetnotes/sparkle_ed25519
```

**Back this file up.** If you lose it, you have to ship a new public
key in a new binary, which means existing clients can't auto-update
to anything signed with a new key — they'll need a manual reinstall.

### 2. Pick where the appcast lives

The appcast is a static XML file accessible over HTTPS. Three options
in increasing complexity:

- **GitHub Pages** — push `appcast.xml` to a `gh-pages` branch and
  Sparkle hits `https://<user>.github.io/<repo>/appcast.xml`.
  Free, no infra, perfectly fine for a small operator.
- **Custom domain on S3 / Cloudflare R2** — same content, your URL.
- **Inside the same Node server** — possible but couples release
  reach to server uptime. Don't.

This guide uses `https://updates.meetnotes.app/appcast.xml` as a
placeholder. Substitute your actual URL.

### 3. Set the build-time env vars

Two env vars feed `mac/Scripts/build.sh`:

```bash
# Add these to your shell profile (or your CI secret store).
export MEETNOTES_SU_FEED_URL="https://updates.meetnotes.app/appcast.xml"
export MEETNOTES_SU_PUBLIC_KEY="<paste base64 public key from generate_keys output>"

# And one for appcast.sh:
export MEETNOTES_SU_DOWNLOAD_URL_BASE="https://updates.meetnotes.app/releases"
```

Without these, the build still succeeds — Sparkle just stays inert
(no feed, no key, "Check for Updates…" reports "no updates").

## Per-release workflow

### 1. Bump the version

```bash
# Edit mac/VERSION (and only mac/VERSION) — build.sh and dmg.sh both
# read it.
echo "0.2.0" > mac/VERSION
git add mac/VERSION
git commit -m "chore(mac): v0.2.0"
```

If you have a `CHANGELOG.md`, add a section heading for the version.

### 2. Build → sign → notarize → DMG

```bash
cd mac
./Scripts/release.sh
```

That produces `mac/MeetNotesMac_v0.2.0.dmg`. The DMG contains the .app
with Sparkle wired in via Info.plist — clients of this DMG will
auto-update on the next release.

### 3. Generate the appcast entry

```bash
./Scripts/appcast.sh > /tmp/new-item.xml
cat /tmp/new-item.xml
```

The script reads the DMG, computes its EdDSA signature with your
private key, and prints a single `<item>` block ready to splice into
your hosted appcast.xml. **Verify the signature on the printed
attribute** — it should look like `sparkle:edSignature="..."`.

### 4. Splice into the hosted appcast.xml

Pull your appcast repo, paste the new item ABOVE existing items
(Sparkle uses RSS-style "newest first" ordering), commit, push.

```bash
git clone https://github.com/yourorg/meetnotes-appcast.git
cd meetnotes-appcast
# edit appcast.xml — paste the new <item> right after <language>
git add appcast.xml
git commit -m "release: v0.2.0"
git push
```

The first existing item is `<item>v0.1.x</item>`; you're adding
`<item>v0.2.0</item>` above it.

### 5. Upload the DMG

Drop `MeetNotesMac_v0.2.0.dmg` at the URL declared in
`MEETNOTES_SU_DOWNLOAD_URL_BASE/MeetNotesMac_v0.2.0.dmg`. For GitHub
Pages that's typically `gh-pages/releases/`; for S3 it's an `s3 cp`.

### 6. Verify end-to-end

On a test machine running the previous version:

1. App → Check for Updates… (the menu item under the apple-style app
   menu, or Settings → Updates → Check now).
2. The Sparkle modal shows the new version's release notes pulled
   from `<description>`.
3. Click Install. Sparkle downloads, verifies the EdDSA signature
   against the embedded public key, swaps the .app, relaunches.

If verification fails (signature/key mismatch), Sparkle aborts with a
clear error. Don't ship the appcast entry until you've verified once.

## Troubleshooting

| Symptom | Cause |
|---|---|
| "Update Error — A connection failure occurred" | `SUFeedURL` missing in Info.plist or unreachable from the client |
| "The update is improperly signed" | `SUPublicEDKey` in the running binary doesn't match the key used by `sign_update` |
| Sparkle never offers an update even though the appcast has one | `<sparkle:version>` in the appcast item must be a higher integer than the running app's `CFBundleVersion` |
| "Check for Updates…" is greyed out | Sparkle's `canCheckForUpdates` flips false during an in-flight check. Wait 30s. |

## Key rotation (advanced)

If the EdDSA private key is compromised:

1. Generate a new key pair (same one-time setup as above).
2. Ship a release whose Info.plist contains the NEW
   `SUPublicEDKey` AND has been signed with the new private key.
3. Existing users on the compromised key MUST update through this
   release before the next one — there is no automatic graceful
   path. Communicate via your release-notes channel.
4. After everyone is past that release, you can stop signing with
   the compromised key.

Sparkle supports two public keys at once via `SUPublicEDKeyFile` for
exactly this transition; that's outside the scope of this guide.

## See also

- [Sparkle docs](https://sparkle-project.org/documentation/)
- [`mac/Scripts/release.sh`](../../mac/Scripts/release.sh) — release pipeline
- [`mac/Scripts/appcast.sh`](../../mac/Scripts/appcast.sh) — appcast item generator
- [`mac/Scripts/build.sh`](../../mac/Scripts/build.sh) — where Sparkle env vars feed Info.plist
