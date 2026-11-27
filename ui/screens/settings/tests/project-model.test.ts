import { test } from "node:test";
import assert from "node:assert/strict";
import { PATHS_TEXT, bytesLabel, cloneError, codeDirOf, decodeMemory, decodePaths, folderNote, parseBackendUrl, projectError, safeRelativePath, syncProviderFor } from "../project-model.ts";

const CLONE_AUTH_SENTENCE =
  "The repository refused access. If it is private, paste a personal access token with read access (GitHub: repo scope; GitLab: read_repository) and press Clone again.";

test("clone: auth refusals map to one actionable sentence for string and {code,message} inputs", () => {
  const texts = [
    "Cloning into '/home/u/LLM_new/code/smart-input'...\nremote: HTTP Basic: Access denied. If a password was provided for Git authentication, the password was incorrect",
    "fatal: Authentication failed for 'https://gitlab.com/g/r.git/'",
    "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
    "remote: Repository not found.",
    "fatal: unable to access 'https://x/': The requested URL returned error: 403",
    "fatal: unable to access 'https://x/': The requested URL returned error: 401",
  ];
  for (const text of texts) {
    assert.equal(cloneError(text), CLONE_AUTH_SENTENCE, text);
    assert.equal(cloneError({ code: "clone_failed", message: text }), CLONE_AUTH_SENTENCE, text);
  }
  // An auth marker past the 200-character limit still counts, because the match runs on the full text.
  assert.equal(cloneError(`fatal: ${"slow network ".repeat(20)} Access denied`), CLONE_AUTH_SENTENCE);
});

test("clone: a long non-auth text ends at a whole word with an ellipsis", () => {
  const long = `fatal: ${"unable to reach the remote because the network path was slow ".repeat(5)}`;
  const got = cloneError(long);
  assert.ok(got.endsWith("…"), got);
  const body = got.slice(0, -1);
  assert.ok(body.length <= 200, String(body.length));
  assert.ok(long.startsWith(body), "the kept text is a prefix of the original");
  assert.match(long.charAt(body.length), /\s/, "the cut falls on a word boundary");
  assert.doesNotMatch(body, /\s$/);
  // A single word longer than the limit has no boundary, so it is hard-cut.
  assert.equal(cloneError("x".repeat(300)), `${"x".repeat(200)}…`);
});

test("clone: other errors are unchanged", () => {
  const exact = `${"a".repeat(198)} b`;
  assert.equal(exact.length, 200);
  assert.equal(cloneError(exact), exact, "exactly at the limit is not cut");
  assert.equal(cloneError("fatal: destination path already exists and is not an empty directory."), "fatal: destination path already exists and is not an empty directory.");
  assert.equal(cloneError({ code: "clone_timeout", message: "The clone timed out." }), "The clone timed out.");
  assert.equal(cloneError({ code: "no_project" }), PATHS_TEXT.noProject);
  assert.equal(cloneError({}), "The clone failed.");
  assert.equal(cloneError("   "), "The clone failed.");
});

test("safeRelativePath: project-relative only (no absolute, drive, .., controls)", () => {
  assert.equal(safeRelativePath("system/graph/graph.json"), "system/graph/graph.json");
  assert.equal(safeRelativePath("llm-doc/plans"), "llm-doc/plans");
  for (const bad of ["/etc/passwd", "C:\\x", "a/../b", "../x", "", "a\u0000b", "x".repeat(4097), 3, null]) {
    assert.equal(safeRelativePath(bad as unknown), null, String(bad));
  }
});

test("paths: folders decoded, invalid rows dropped, text cleaned", () => {
  const got = decodePaths({
    root: "/Users/a/proj",
    id: "proj-1",
    folders: [
      { name: "system", exists: true },
      { name: "llm-doc/plans", exists: false },
      { name: "/abs", exists: true },
      { name: "x", exists: "yes" },
      null,
    ],
  });
  assert.deepEqual(got, { root: "/Users/a/proj", id: "proj-1", folders: [{ name: "system", exists: true }, { name: "llm-doc/plans", exists: false }], isProject: true });
  assert.equal(decodePaths({ root: "/p" }), null);
  assert.equal(decodePaths(null), null);
  const many = decodePaths({ root: "/p", id: "p", folders: Array.from({ length: 100 }, (_, i) => ({ name: `d${i}`, exists: true })) });
  assert.equal(many?.folders.length, 50);
});

test("memory: graph optional, files validated and bounded, database rows ignored", () => {
  const got = decodeMemory({
    root: "/p",
    graph: { path: "system/graph/graph.json", sizeBytes: 2048 },
    files: [
      { name: "memory.json", path: "system/memory.json", sizeBytes: 3 },
      { name: "x", path: "/abs", sizeBytes: 1 },
      { name: "y", path: "system/y", sizeBytes: -1 },
      { name: "", path: "system/z", sizeBytes: 1 },
    ],
  });
  assert.deepEqual(got?.graph, { path: "system/graph/graph.json", sizeBytes: 2048 });
  assert.deepEqual(got?.files, [{ name: "memory.json", path: "system/memory.json", sizeBytes: 3 }]);
  assert.deepEqual(decodeMemory({ root: "/p", graph: null, files: [] }), { root: "/p", graph: null, files: [] });
  assert.equal(decodeMemory({ graph: {} }), null);
  const badGraph = decodeMemory({ root: "/p", graph: { path: "/abs", sizeBytes: 1 }, files: [] });
  assert.equal(badGraph?.graph, null, "an invalid graph row reads as not generated");
});

test("labels and errors: sizes, and a missing project becomes a sentence", () => {
  assert.equal(bytesLabel(0), "0 B");
  assert.equal(bytesLabel(812), "812 B");
  assert.equal(bytesLabel(12 * 1024), "12 KB");
  assert.equal(bytesLabel(3.4 * 1024 * 1024), "3.4 MB");
  assert.equal(projectError("no project is open"), PATHS_TEXT.noProject);
  assert.equal(projectError({ code: "no_project" }), PATHS_TEXT.noProject);
  assert.equal(projectError("boom"), "boom");
  assert.equal(projectError("x".repeat(500)).length, 200);
  assert.equal(projectError({}), "The project folders could not be read.");
});

test("the notes folder sync badge recognises the Mac's four providers", () => {
  assert.match(syncProviderFor("/Users/x/Library/Mobile Documents/com~apple~CloudDocs/Notes")!, /iCloud/);
  assert.match(syncProviderFor("/Users/x/Dropbox/Notes")!, /Dropbox/);
  assert.match(syncProviderFor("/Users/x/Library/CloudStorage/GoogleDrive-a/Notes")!, /Google Drive/);
  assert.match(syncProviderFor("/Users/x/Library/CloudStorage/OneDrive-a/Notes")!, /OneDrive/);
  assert.equal(syncProviderFor("/Users/x/notes"), null);
});

test("canonical folders carry the Mac Paths explanations", () => {
  assert.equal(folderNote("code"), "Code files");
  assert.equal(folderNote("source"), "Meeting & email transcripts");
  assert.match(folderNote("llm-doc/plans")!, /KB plans/);
  assert.equal(folderNote("nope"), null);
});

test("backend URLs are loopback-only and need an explicit port", () => {
  assert.deepEqual(parseBackendUrl("http://127.0.0.1:3457"), { port: 3457 });
  assert.deepEqual(parseBackendUrl("http://localhost:4567"), { port: 4567 });
  for (const bad of ["http://example.com:3457", "http://127.0.0.1", "ftp://127.0.0.1:1", "nope", "http://127.0.0.1:80"]) {
    assert.ok("error" in parseBackendUrl(bad), bad);
  }
});

test("paths_plain_folder_is_a_normal_project: an explicit isProject false decodes to false, an omitted field to true", () => {
  const plain = decodePaths({ root: "/srv/home/docs", id: "", folders: [{ name: "code", exists: false }], isProject: false });
  assert.deepEqual(plain, { root: "/srv/home/docs", id: "", folders: [{ name: "code", exists: false }], isProject: false });
  assert.equal("plainFolder" in PATHS_TEXT, false, "the plain-folder notice no longer exists");
});

test("code_dir_of_uses_one_rule: <root>/code when a code folder is listed, else null, whatever isProject says", () => {
  const plain = decodePaths({ root: "/srv/home/docs/", id: "", folders: [{ name: "code", exists: false }], isProject: false });
  assert.equal(plain && codeDirOf(plain), "/srv/home/docs/code");
  const none = decodePaths({ root: "/srv/p", id: "p", folders: [{ name: "system", exists: true }] });
  assert.equal(none && codeDirOf(none), null);
});

const OLD_SERVER_ERROR = { code: "not_a_project", message: "This folder is not an LLM-IDE project." };
const SERVER_OUTDATED_SENTENCE =
  "The server part is older than this app, so it cannot set up this folder. In Settings → Server & Backend → SSH server, press Disconnect and then Connect to update it, then try again.";

test("projectError: an old server's not_a_project says the server needs an update", () => {
  assert.equal(projectError(OLD_SERVER_ERROR), SERVER_OUTDATED_SENTENCE);
  assert.equal(projectError({ code: "other_code", message: "Something else." }), "Something else.");
});

test("cloneError: an old server's not_a_project says the server needs an update", () => {
  assert.equal(cloneError(OLD_SERVER_ERROR), SERVER_OUTDATED_SENTENCE);
  assert.equal(cloneError({ code: "other_code", message: "Something else." }), "Something else.");
});
