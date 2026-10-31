// Declares every custom command in an AppManifest so each needs an explicit
// `allow-<command>` permission in a capability file (capabilities/*.json). Without a
// manifest Tauri allows all app commands to every window. Keep this list in sync with
// `generate_handler!` in src/lib.rs; the build fails on a capability naming an
// unknown permission, and `scripts/check-capabilities.mjs` fails on a command with
// no grant or a wildcard / broad permission.
const COMMANDS: &[&str] = &[
    "ping",
    "core_status",
    "secrets_status",
    "read_graph_file",
    "bench",
    "bench_done",
    "autobench_mode",
    "graph_path_override",
    "theme_override",
    "section_override",
    "pty_spawn",
    "pty_write",
    "pty_resize",
    "pty_ack",
    "pty_kill",
    "sse_replay_start",
    "sse_replay_stop",
    "sse_channel_stream",
    "ax_probe",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("tauri build failed");
}
