use super::*;

/// Owns a temp folder (or marker file) and removes it on drop, so a failing test leaves nothing behind.
struct TempDirGuard(std::path::PathBuf);

impl Drop for TempDirGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
        let _ = std::fs::remove_file(&self.0);
    }
}

impl std::ops::Deref for TempDirGuard {
    type Target = std::path::Path;
    fn deref(&self) -> &std::path::Path {
        &self.0
    }
}

impl AsRef<std::path::Path> for TempDirGuard {
    fn as_ref(&self) -> &std::path::Path {
        &self.0
    }
}

fn tmp(tag: &str) -> TempDirGuard {
    let d = std::env::temp_dir().join(format!("llmide-prefs-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    TempDirGuard(d)
}

const DEFAULT_ON_HOST_API: [&str; 3] = ["LLMIDE_HOST_API_READ", "LLMIDE_HOST_API_COMPOSE", "LLMIDE_HOST_API_TOOL_APPROVALS"];

/// The core env minus the three always-passed Host API capabilities, for tests about the other switches.
fn without_host_api(v: Vec<(&'static str, String)>) -> Vec<(&'static str, String)> {
    v.into_iter().filter(|(k, _)| !DEFAULT_ON_HOST_API.contains(k)).collect()
}

#[test]
fn web_origins_follow_the_shared_fixture_rule() {
    let text = include_str!("../../../schema/host-api/v1/fixtures/security/origins.json");
    let fixture: serde_json::Value = serde_json::from_str(text).unwrap();
    let raw: Vec<String> = fixture["allowlist"].as_str().unwrap().split(',').map(str::to_string).collect();
    let want: Vec<String> = fixture["parsed"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect();
    assert_eq!(normalize_web_origins(&raw), want);
}

#[test]
fn web_origins_validate_normalise_and_bound() {
    assert_eq!(normalize_web_origin(" HTTPS://LLM-IDE.com "), Some("https://llm-ide.com".to_string()));
    assert_eq!(normalize_web_origin("https://a.example.com:443"), Some("https://a.example.com".to_string()));
    for bad in ["", "*", "https://localhost", "https://1.2.3.4", "http://example.com", "http://localhost", "http://localhost:0", "https://a.example.com:70000", "https://a.example.com/"] {
        assert_eq!(normalize_web_origin(bad), None, "{bad}");
    }
    let many: Vec<String> = (0..20).map(|i| format!("https://h{i}.example.com")).collect();
    assert_eq!(normalize_web_origins(&many).len(), 10);
    let long: Vec<String> = (0..3).map(|i| format!("https://{}{i}.example.com", "a".repeat(60))).collect();
    assert!(normalize_web_origins(&long).join(",").len() <= 2048);
    let dup = vec!["https://a.example.com".to_string(), "HTTPS://a.example.com".to_string(), "bad".to_string()];
    assert_eq!(normalize_web_origins(&dup), vec!["https://a.example.com".to_string()]);
}

#[test]
fn web_origins_reach_the_core_only_when_set() {
    assert!(!core_env_pairs(&Prefs::default(), None).iter().any(|(k, _)| *k == "LLMIDE_HOST_API_WEB_ORIGINS"));
    let p = Prefs::default().patched(&PrefsPatch {
        host_api_web_origins: Some(vec!["https://llm-ide.com".into(), "http://localhost:5173".into(), "nope".into()]), ..Default::default()
    });
    assert!(core_env_pairs(&p, None).contains(&("LLMIDE_HOST_API_WEB_ORIGINS", "https://llm-ide.com,http://localhost:5173".to_string())));
    assert_eq!(parse(&serde_json::to_string(&p).unwrap()).host_api_web_origins, p.host_api_web_origins);
}

#[test]
fn defaults_are_off_for_every_token_affecting_switch() {
    let d = Prefs::default();
    assert!(!d.router && !d.cap && !d.compress && !d.learn && !d.continue_summary);
    assert!(!d.host_api_tls && !d.host_api_push, "the listener and push stay opt-in");
    assert_eq!(d.lta_mode, LtaMode::Off);
    assert!(d.terminal);
    assert!(without_host_api(core_env_pairs(&d, None)).is_empty(), "defaults pass nothing else to the core");
}

#[test]
fn workspace_write_and_shell_are_opt_in_and_shell_needs_write() {
    let d = Prefs::default();
    assert!(!d.host_api_workspace_write && !d.host_api_shell);
    let keys = |p: &Prefs| core_env_pairs(p, None).into_iter().map(|(k, _)| k).collect::<Vec<_>>();
    assert!(!keys(&d).contains(&"LLMIDE_HOST_API_WORKSPACE_WRITE") && !keys(&d).contains(&"LLMIDE_HOST_API_SHELL"));
    let shell_only = Prefs { host_api_shell: true, ..Prefs::default() };
    assert!(!keys(&shell_only).contains(&"LLMIDE_HOST_API_SHELL"), "shell alone is never passed");
    let write = d.patched(&PrefsPatch { host_api_workspace_write: Some(true), ..Default::default() });
    assert!(core_env_pairs(&write, None).contains(&("LLMIDE_HOST_API_WORKSPACE_WRITE", "1".to_string())));
    assert!(!keys(&write).contains(&"LLMIDE_HOST_API_SHELL"));
    let both = write.patched(&PrefsPatch { host_api_shell: Some(true), ..Default::default() });
    assert!(core_env_pairs(&both, None).contains(&("LLMIDE_HOST_API_SHELL", "1".to_string())));
    let back = parse(&serde_json::to_string(&both).unwrap());
    assert!(back.host_api_workspace_write && back.host_api_shell);
    assert!(!parse(r#"{"terminal":true}"#).host_api_workspace_write, "old files default to off");
}

#[test]
fn host_api_prefs_reach_the_core_as_exactly_one_and_nothing_else() {
    let p = Prefs { host_api_tls: true, host_api_read: true, host_api_compose: true, host_api_push: true, host_api_tool_approvals: true, ..Prefs::default() };
    assert_eq!(core_env_pairs(&p, None), vec![
        ("LLMIDE_HOST_API_TLS", "1".to_string()),
        ("LLMIDE_HOST_API_READ", "1".to_string()),
        ("LLMIDE_HOST_API_COMPOSE", "1".to_string()),
        ("LLMIDE_HOST_API_PUSH", "1".to_string()),
        ("LLMIDE_HOST_API_TOOL_APPROVALS", "1".to_string()),
    ]);
    // A patch turns them back off; each one alone passes only its own key.
    let off = p.patched(&PrefsPatch { host_api_read: Some(false), ..Default::default() });
    assert!(core_env_pairs(&off, None).contains(&("LLMIDE_HOST_API_READ", "0".to_string())));
    let only_push = Prefs { host_api_push: true, ..Prefs::default() };
    assert_eq!(without_host_api(core_env_pairs(&only_push, None)), vec![("LLMIDE_HOST_API_PUSH", "1".to_string())]);
    // A file without the keys (written before they existed) gets the defaults: listener and push off.
    let old: Prefs = serde_json::from_str(r#"{"ltaMode":"off","router":false,"cap":false,"compress":false,"learn":false,"terminal":true,"theme":"dark"}"#).unwrap();
    assert!(!old.host_api_tls && !old.host_api_push);
}

#[test]
fn read_compose_and_tool_approvals_default_on_and_an_off_switch_is_honoured() {
    let d = Prefs::default();
    assert!(d.host_api_read && d.host_api_compose && d.host_api_tool_approvals);
    let on: Vec<_> = DEFAULT_ON_HOST_API.iter().map(|k| (*k, "1".to_string())).collect();
    assert_eq!(core_env_pairs(&d, None), on, "a paired phone works with no setup");
    // Each switch turned off reaches the core as an explicit 0 (the core enables only the exact value 1).
    let off = d.patched(&PrefsPatch { host_api_read: Some(false), host_api_compose: Some(false), host_api_tool_approvals: Some(false), ..Default::default() });
    let zero: Vec<_> = DEFAULT_ON_HOST_API.iter().map(|k| (*k, "0".to_string())).collect();
    assert_eq!(core_env_pairs(&off, None), zero);
    // The off switch survives a save and a reload.
    let dir = tmp("host-api-off");
    save_to(&dir, &off).unwrap();
    let back = load_from(&dir);
    assert!(!back.host_api_read && !back.host_api_compose && !back.host_api_tool_approvals);
    let _ = std::fs::remove_dir_all(&dir);
    // A file without the keys reads them as on; a stored false is kept once the file carries the migration marker.
    assert!(parse(r#"{"terminal":true}"#).host_api_read);
    let stored = parse(r#"{"hostApiRead":false,"hostApiCompose":true,"hostApiToolApprovals":false,"hostApiCapsMigrated":true}"#);
    assert!(!stored.host_api_read && stored.host_api_compose && !stored.host_api_tool_approvals);
}

#[test]
fn remote_server_prefs_round_trip_normalize_and_never_require_a_restart() {
    let d = Prefs::default();
    assert_eq!(d.remote_server.mode, ServerMode::Local);
    assert_eq!(d.remote_server.port, 22);
    let patched = d.patched(&PrefsPatch {
        remote_server: Some(RemoteServerPrefs {
            mode: ServerMode::Remote,
            host: "  example.com  ".into(),
            port: 0,
            user: " alice ".into(),
            key_path: " /home/alice/.ssh/id_ed25519 ".into(),
            label: " prod ".into(),
            hub_url: " https://hub.example.com ".into(),
            tls_pin: "sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".into(),
            ssh_auth: SshAuthKind::Key,
            ssh_host_pin: String::new(),
            ..RemoteServerPrefs::default()
        }),
        ..Default::default()
    });
    assert_eq!(patched.remote_server.mode, ServerMode::Remote);
    assert_eq!(patched.remote_server.host, "example.com");
    assert_eq!(patched.remote_server.user, "alice");
    assert_eq!(patched.remote_server.key_path, "/home/alice/.ssh/id_ed25519");
    assert_eq!(patched.remote_server.label, "prod");
    assert_eq!(patched.remote_server.port, 22, "a zero port falls back to 22");
    assert!(!view(patched.clone(), true).restart_needed, "phase 1 stores the choice but does not act on it");
    let back = parse(&serde_json::to_string(&patched).unwrap());
    assert_eq!(back.remote_server, patched.remote_server);
    assert_eq!(parse(r#"{"ltaMode":"off"}"#).remote_server, RemoteServerPrefs::default(), "an older file is local");
}

#[test]
fn a_prefs_file_keeps_the_saved_hub_url_and_pin_across_a_restart() {
    let file = r#"{"ltaMode":"off","remoteServer":{"mode":"remote","host":"ssh.example.com","port":22,"user":"deploy","keyPath":"/k","label":"prod","hubUrl":"https://hub.example.com","tlsPin":""}}"#;
    let loaded = parse(file);
    assert_eq!(loaded.remote_server.mode, ServerMode::Remote);
    assert_eq!(loaded.remote_server.hub_url, "https://hub.example.com");
    assert_eq!(loaded.remote_server.tls_pin, "", "public-CA trust keeps an empty pin");
    let pinned = parse(&file.replace(r#""tlsPin":"""#, r#""tlsPin":"sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA""#));
    assert_eq!(pinned.remote_server.tls_pin, "sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
}

#[test]
fn a_webpki_hub_keeps_an_empty_pin_and_a_bad_url_is_cleared() {
    let empty = RemoteServerPrefs { hub_url: "https://hub.example.com".into(), tls_pin: String::new(), ..RemoteServerPrefs::default() }.normalized();
    assert_eq!(empty.hub_url, "https://hub.example.com");
    assert_eq!(empty.tls_pin, "", "public-CA trust needs no pin");
    let bad = RemoteServerPrefs { hub_url: "http://hub.example.com".into(), tls_pin: "sha256:short".into(), ..RemoteServerPrefs::default() }.normalized();
    assert_eq!(bad.hub_url, "");
    assert_eq!(bad.tls_pin, "");
    let local = RemoteServerPrefs { hub_url: "https://localhost:3457".into(), ..RemoteServerPrefs::default() }.normalized();
    if cfg!(debug_assertions) { assert_eq!(local.hub_url, "https://localhost:3457"); } else { assert_eq!(local.hub_url, ""); }
}

#[test]
fn a_webview_patch_cannot_inject_a_hub_url_or_pin() {
    let mut base = Prefs::default();
    base.remote_server.hub_url = "https://hub.example.com".into();
    base.remote_server.tls_pin = "sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".into();
    let patched = base.patched(&PrefsPatch {
        remote_server: Some(RemoteServerPrefs {
            mode: ServerMode::Remote, host: "evil.example.com".into(), port: 22, user: "u".into(), key_path: "/k".into(), label: String::new(),
            hub_url: "http://evil.example.com".into(),
            tls_pin: "sha256:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB".into(),
            ssh_auth: SshAuthKind::Key,
            ssh_host_pin: String::new(),
            ..RemoteServerPrefs::default()
        }),
        ..Default::default()
    });
    assert_eq!(patched.remote_server.hub_url, "https://hub.example.com");
    assert_eq!(patched.remote_server.tls_pin, "sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
}

#[test]
fn a_webview_patch_cannot_write_the_ssh_pin() {
    let mut base = Prefs::default();
    base.remote_server.ssh_host_pin = "example.com:22 ssh-ed25519 AAAA".into();
    let patched = base.patched(&PrefsPatch {
        remote_server: Some(RemoteServerPrefs {
            mode: ServerMode::Ssh, host: "evil.example.com".into(), port: 22, user: "u".into(), key_path: "/k".into(),
            ssh_host_pin: "evil.example.com:22 ssh-ed25519 BBBB".into(),
            ..RemoteServerPrefs::default()
        }),
        ..Default::default()
    });
    assert_eq!(patched.remote_server.ssh_host_pin, "example.com:22 ssh-ed25519 AAAA");
}

/// A 4096-bit RSA pin is about 740 characters; it must survive a save and a load unchanged. The legacy field
/// moves into the list on load, so the list holds it.
#[test]
fn a_long_rsa_pin_round_trips_through_the_file() {
    let d = tmp("pin-long");
    let pin = format!("example.com:22 ssh-rsa {}", (0..740).map(|i| char::from(b'A' + (i % 26) as u8)).collect::<String>());
    let p = Prefs { remote_server: RemoteServerPrefs { ssh_host_pin: pin.clone(), ..RemoteServerPrefs::default() }, ..Prefs::default() };
    save_to(&d, &p).unwrap();
    let back = load_from(&d);
    assert_eq!(back.remote_server.ssh_known_hosts, vec![pin], "a pin longer than 512 characters must not be cut");
    assert_eq!(back.remote_server.ssh_host_pin, "");
}

/// Over the cap the pin is cleared, never truncated: a cut pin could still decode and read as another key.
#[test]
fn an_over_cap_pin_loads_empty_not_truncated() {
    let d = tmp("pin-over");
    let pin = format!("example.com:22 ssh-rsa {}", "A".repeat(SSH_HOST_PIN_MAX));
    let p = Prefs { remote_server: RemoteServerPrefs { ssh_host_pin: pin, ..RemoteServerPrefs::default() }, ..Prefs::default() };
    save_to(&d, &p).unwrap();
    assert_eq!(load_from(&d).remote_server.ssh_host_pin, "");
}

#[test]
fn upsert_ssh_known_host_refuses_an_over_cap_pin() {
    let _guard = prefs_guard();
    let before = stored().remote_server;
    let too_long = "A".repeat(SSH_HOST_PIN_MAX + 1);
    let err = upsert_ssh_known_host(format!("example.com:22 ssh-rsa {too_long}")).unwrap_err();
    assert_eq!(err.code, "invalid_host_key");
    assert_eq!(stored().remote_server.ssh_known_hosts, before.ssh_known_hosts, "a refused pin stores nothing");
}

#[test]
fn an_old_file_has_no_ssh_pin() {
    let loaded = parse(r#"{"remoteServer":{"mode":"ssh","host":"example.com","port":22,"user":"alice","keyPath":"/k"}}"#);
    assert_eq!(loaded.remote_server.mode, ServerMode::Ssh);
    assert_eq!(loaded.remote_server.ssh_host_pin, "");
}

#[test]
fn the_remote_block_has_no_field_for_key_contents() {
    assert!(serde_json::from_str::<PrefsPatch>(r#"{"remoteServer":{"host":"x","keyContents":"secret"}}"#).is_err());
    assert!(serde_json::from_str::<PrefsPatch>(r#"{"remoteServer":{"mode":"remote","keyPath":"/tmp/key"}}"#).is_ok());
    assert!(serde_json::from_str::<PrefsPatch>(r#"{"remoteServer":{"mode":"elsewhere"}}"#).is_err());
}

#[test]
fn old_prefs_file_still_loads() {
    let loaded = parse(r#"{"ltaMode":"off","remoteServer":{"host":"example.com","port":22,"user":"alice","keyPath":"/k"}}"#);
    assert_eq!(loaded.remote_server.ssh_auth, SshAuthKind::Key);
    assert_eq!(loaded.remote_server.mode, ServerMode::Local);
}

#[test]
fn ssh_mode_round_trips() {
    let d = tmp("ssh");
    let p = Prefs {
        remote_server: RemoteServerPrefs { mode: ServerMode::Ssh, ssh_auth: SshAuthKind::Password, host: "example.com".into(), user: "alice".into(), ..RemoteServerPrefs::default() },
        ..Prefs::default()
    };
    save_to(&d, &p).unwrap();
    let back = load_from(&d);
    assert_eq!(back.remote_server.mode, ServerMode::Ssh);
    assert_eq!(back.remote_server.ssh_auth, SshAuthKind::Password);
    assert_eq!(back, p);
}

#[test]
fn set_remote_ssh_validates() {
    let _guard = prefs_guard();
    let before = stored().remote_server;
    let code = |r: Result<PrefsView, FsError>| r.unwrap_err().code;
    assert_eq!(code(set_remote_ssh("-x".into(), 22, "alice".into(), "/k".into(), SshAuthKind::Key, ServerMode::Ssh)), "invalid_host");
    assert_eq!(code(set_remote_ssh("example.com".into(), 0, "alice".into(), "/k".into(), SshAuthKind::Key, ServerMode::Ssh)), "invalid_port");
    assert_eq!(code(set_remote_ssh("example.com".into(), 22, "-l".into(), "/k".into(), SshAuthKind::Key, ServerMode::Ssh)), "invalid_user");
    assert_eq!(code(set_remote_ssh("example.com".into(), 22, "alice".into(), "".into(), SshAuthKind::Key, ServerMode::Ssh)), "invalid_key_path");
    // Password auth needs no key file, so an empty key path is saved as is.
    let saved = set_remote_ssh("example.com".into(), 22, "alice".into(), "  ".into(), SshAuthKind::Password, ServerMode::Ssh).unwrap();
    assert_eq!(saved.stored.remote_server.ssh_auth, SshAuthKind::Password);
    assert_eq!(saved.stored.remote_server.mode, ServerMode::Ssh);
    assert_eq!(saved.stored.remote_server.key_path, "");
    // The writer is global state; put back what this test found.
    let _ = apply(PrefsPatch { remote_server: Some(before), ..Default::default() });
}

#[test]
fn no_password_field_exists() {
    let p = Prefs { remote_server: RemoteServerPrefs { ssh_auth: SshAuthKind::Password, ..RemoteServerPrefs::default() }, ..Prefs::default() };
    let value = serde_json::to_value(&p).unwrap();
    fn collect_keys(v: &serde_json::Value, keys: &mut Vec<String>) {
        match v {
            serde_json::Value::Object(map) => {
                for (k, child) in map {
                    keys.push(k.clone());
                    collect_keys(child, keys);
                }
            }
            serde_json::Value::Array(items) => items.iter().for_each(|child| collect_keys(child, keys)),
            _ => {}
        }
    }
    let mut keys = Vec::new();
    collect_keys(&value, &mut keys);
    let with_pass: Vec<&String> = keys.iter().filter(|k| k.to_lowercase().contains("pass")).collect();
    assert!(with_pass.is_empty(), "{with_pass:?}");
    assert_eq!(value["remoteServer"]["sshAuth"], "password");
}

#[test]
fn continue_summary_reaches_the_core_as_exactly_on() {
    let p = Prefs { continue_summary: true, ..Prefs::default() };
    assert_eq!(without_host_api(core_env_pairs(&p, None)), vec![("LLMIDE_V2_CONTINUE_SUMMARY", "on".to_string())]);
    let off = p.patched(&PrefsPatch { continue_summary: Some(false), ..Default::default() });
    assert!(without_host_api(core_env_pairs(&off, None)).is_empty());
    let old: Prefs = serde_json::from_str(r#"{"ltaMode":"off","router":false,"cap":false,"compress":false,"learn":false,"terminal":true,"theme":"dark"}"#).unwrap();
    assert!(!old.continue_summary, "an older prefs file reads as off");
}

#[test]
fn core_env_is_exactly_on_and_cap_compress_need_the_router() {
    let mut p = Prefs { router: true, cap: true, compress: true, learn: true, ..Prefs::default() };
    let v = without_host_api(core_env_pairs(&p, None));
    let names: Vec<&str> = v.iter().map(|(k, _)| *k).collect();
    assert_eq!(names, ["LLMIDE_ROUTER", "LLMIDE_ROUTER_CAP", "LLMIDE_ROUTER_COMPRESS", "LLMIDE_ROUTER_LEARN"]);
    assert!(v.iter().all(|(_, val)| val == "on"));
    p.router = false;
    let v = without_host_api(core_env_pairs(&p, None));
    assert_eq!(v.iter().map(|(k, _)| *k).collect::<Vec<_>>(), ["LLMIDE_ROUTER_LEARN"]);
}

#[test]
fn patching_the_router_off_clears_cap_and_compress() {
    let on = Prefs::default().patched(&PrefsPatch { router: Some(true), cap: Some(true), compress: Some(true), ..Default::default() });
    assert!(on.cap && on.compress);
    let off = on.patched(&PrefsPatch { router: Some(false), ..Default::default() });
    assert!(!off.router && !off.cap && !off.compress);
    let stray = Prefs::default().patched(&PrefsPatch { cap: Some(true), ..Default::default() });
    assert!(!stray.cap, "cap alone cannot be stored while the router is off");
}

#[test]
fn an_explicit_profile_is_normalized_ordered_and_always_keeps_chat() {
    let p = Prefs::default().patched(&PrefsPatch {
        features: Some(vec!["doc_gen".into(), "nope".into(), "agent_chat".into(), "file_explorer".into(), "doc_gen".into()]),
        ..Default::default()
    });
    assert_eq!(p.features, ["agent_chat", "file_explorer", "doc_gen"], "known keys only, canonical order, chat forced");
    assert!(!p.terminal, "an explicit profile without the terminal key turns the legacy flag off");
    let all = Prefs::default().patched(&PrefsPatch { features: Some(vec!["file_explorer".into()]), ..Default::default() });
    assert_eq!(all.features, ["agent_chat", "file_explorer"]);
    let empty = Prefs::default().patched(&PrefsPatch { features: Some(vec![]), ..Default::default() });
    assert!(empty.features.is_empty(), "an empty list stays 'inherit every feature'");
}

#[test]
fn the_terminal_switch_and_the_profile_stay_in_step() {
    let with_terminal = Prefs::default().patched(&PrefsPatch {
        features: Some(vec!["agent_chat".into(), "file_explorer".into(), "terminal".into()]),
        ..Default::default()
    });
    assert!(with_terminal.terminal);
    let off = with_terminal.patched(&PrefsPatch { terminal: Some(false), ..Default::default() });
    assert!(!off.terminal);
    assert!(!off.features.iter().any(|k| k == "terminal"), "turning Terminal off removes it from the profile");
    let back = off.patched(&PrefsPatch { terminal: Some(true), ..Default::default() });
    assert!(back.features.iter().any(|k| k == "terminal"));
}

#[test]
fn an_explicit_profile_sets_llmide_features_for_the_core() {
    let p = Prefs::default().patched(&PrefsPatch {
        features: Some(vec!["agent_chat".into(), "file_explorer".into(), "terminal".into()]),
        ..Default::default()
    });
    let v = without_host_api(core_env_pairs(&p, Some("agent_chat,doc_gen")));
    assert_eq!(v, vec![("LLMIDE_FEATURES", "agent_chat,file_explorer,terminal".to_string())]);
    // Terminal off removes it from the explicit profile too.
    let off = p.patched(&PrefsPatch { terminal: Some(false), ..Default::default() });
    assert_eq!(without_host_api(core_env_pairs(&off, None)), vec![("LLMIDE_FEATURES", "agent_chat,file_explorer".to_string())]);
    // The profile wins over the host's own value.
    let two = effective_features_with(None, true, &["agent_chat".into(), "auto_tasks".into()]).unwrap();
    assert_eq!(two, "agent_chat,auto_tasks");
}

#[test]
fn a_legacy_file_without_features_keeps_its_terminal_setting() {
    let text = r#"{"ltaMode":"off","router":false,"cap":false,"compress":false,"learn":false,"terminal":false,"theme":"dark"}"#;
    let p = parse(text);
    assert!(!p.terminal);
    assert!(p.features.is_empty());
    assert_eq!(effective_features_with(None, p.terminal, &p.features).unwrap(), "agent_chat,file_explorer,code_graph_3d,gantt_issues,doc_gen,mobile_sync,auto_tasks");
}

#[test]
fn terminal_off_lists_every_other_feature_and_never_empties() {
    assert_eq!(effective_features(None, true), None);
    assert_eq!(effective_features(Some(" "), true), None);
    let all = effective_features(None, false).unwrap();
    assert_eq!(all, "agent_chat,file_explorer,code_graph_3d,gantt_issues,doc_gen,mobile_sync,auto_tasks");
    assert_eq!(effective_features(Some("agent_chat, terminal,file_explorer"), false).unwrap(), "agent_chat,file_explorer");
    assert_eq!(effective_features(Some("terminal"), false).unwrap(), "agent_chat");
    assert_eq!(effective_features(Some("agent_chat,terminal"), true).unwrap(), "agent_chat,terminal");
    let v = without_host_api(core_env_pairs(&Prefs { terminal: false, ..Prefs::default() }, Some("agent_chat,terminal")));
    assert_eq!(v, vec![("LLMIDE_FEATURES", "agent_chat".to_string())]);
}

#[test]
fn feature_keys_match_the_servers_list() {
    let src = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../extension/core/config.mjs")).unwrap();
    let start = src.find("export const FEATURE_KEYS").unwrap();
    let block = &src[start..start + src[start..].find(']').unwrap()];
    let found: Vec<&str> = block.split('\'').skip(1).step_by(2).collect();
    assert_eq!(found, FEATURE_KEYS, "update prefs.rs FEATURE_KEYS to match config.mjs");
}

#[test]
fn an_old_file_without_the_marker_gets_the_three_capabilities_once() {
    let d = tmp("caps-old");
    let old = r#"{"hostApiRead":false,"hostApiCompose":false,"hostApiToolApprovals":false,"hostApiPush":false}"#;
    std::fs::write(d.join(FILE_NAME), old).unwrap();
    let p = load_from(&d);
    assert!(p.host_api_read && p.host_api_compose && p.host_api_tool_approvals && p.host_api_caps_migrated);
    assert!(!p.host_api_push, "push is not part of the migration");
    assert!(std::fs::read_to_string(d.join(FILE_NAME)).unwrap().contains("hostApiCapsMigrated\": true"), "persisted");
    // After the marker a later explicit off is honoured and survives a reload.
    let off = Prefs { host_api_read: false, ..p };
    save_to(&d, &off).unwrap();
    assert!(!load_from(&d).host_api_read);
}

#[test]
fn a_marked_file_is_untouched_and_a_fresh_install_has_the_marker() {
    let marked = parse(r#"{"hostApiRead":false,"hostApiCompose":false,"hostApiToolApprovals":false,"hostApiCapsMigrated":true}"#);
    assert!(!marked.host_api_read && !marked.host_api_compose && !marked.host_api_tool_approvals);
    let d = tmp("caps-fresh");
    let fresh = load_from(&d);
    assert!(fresh.host_api_read && fresh.host_api_caps_migrated);
    assert!(!d.join(FILE_NAME).exists(), "a missing file is not written by load");
    let bad = tmp("caps-bad");
    std::fs::write(bad.join(FILE_NAME), r#"{"router":true,"nope":1}"#).unwrap();
    let loaded = load_from(&bad);
    assert!(loaded.router, "an unknown key no longer resets the known ones");
    assert!(std::fs::read_to_string(bad.join(FILE_NAME)).unwrap().contains("router"), "the file is only rewritten by the one-time migration");
}

#[test]
fn the_webview_cannot_set_the_backend_paths() {
    assert!(serde_json::from_str::<PrefsPatch>(r#"{"backendNode":"/bin/sh"}"#).is_err());
    assert!(serde_json::from_str::<PrefsPatch>(r#"{"backendDir":"/tmp"}"#).is_err());
    assert!(serde_json::from_str::<PrefsPatch>(r#"{"backendSource":true}"#).is_ok());
    assert!(serde_json::from_str::<PrefsPatch>(r#"{"backendPort":3458}"#).is_ok());
}

#[test]
fn strict_schema_refuses_unknown_keys_and_bad_values() {
    assert!(serde_json::from_str::<PrefsPatch>(r#"{"router":true}"#).is_ok());
    assert!(serde_json::from_str::<PrefsPatch>(r#"{"routerr":true}"#).is_err());
    assert!(serde_json::from_str::<PrefsPatch>(r#"{"ltaMode":"always"}"#).is_err());
    assert!(serde_json::from_str::<PrefsPatch>(r#"{"theme":"neon"}"#).is_err());
    assert!(serde_json::from_str::<PrefsPatch>(r#"{"router":"on"}"#).is_err());
    assert!(serde_json::from_str::<PrefsPatch>(r#"{"__proto__":1}"#).is_err());
}

#[test]
fn a_hand_edited_file_never_widens_anything() {
    assert_eq!(parse("not json"), Prefs::default());
    assert!(parse(r#"{"router":true,"extra":1}"#).router, "an unknown key is ignored, the known ones survive");
    assert_eq!(parse(r#"{"cap":true}"#), Prefs::default(), "cap without router is normalised away");
    assert_eq!(parse(&"x".repeat(MAX_BYTES + 1)), Prefs::default());
    let p = parse(r#"{"router":true,"cap":true,"ltaMode":"shadow","terminal":false,"theme":"light"}"#);
    assert!(p.router && p.cap && !p.terminal);
    assert_eq!((p.lta_mode, p.theme), (LtaMode::Shadow, Theme::Light));
}

#[test]
fn saves_atomically_private_and_round_trips() {
    let d = tmp("rt");
    let p = Prefs { router: true, learn: true, lta_mode: LtaMode::On, ..Prefs::default() };
    save_to(&d, &p).unwrap();
    assert_eq!(load_from(&d), p);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(d.join(FILE_NAME)).unwrap().permissions().mode() & 0o777, 0o600);
    }
    assert!(!d.join("prefs.tmp").exists());
    std::fs::write(d.join(FILE_NAME), vec![b' '; MAX_BYTES + 10]).unwrap();
    assert_eq!(load_from(&d), Prefs::default(), "an oversized file is ignored");
}

#[test]
fn restart_needed_compares_with_the_launch_snapshot_and_ignores_theme() {
    // LAUNCH is the defaults in unit tests.
    let same = view(Prefs { theme: Theme::Light, ..Prefs::default() }, true);
    assert!(!same.restart_needed, "theme applies at once");
    let graph = view(Prefs { graph_auto_update_minutes: 15, ..Prefs::default() }, true);
    assert!(!graph.restart_needed, "the timer reads stored() live");
    let diff = view(Prefs { learn: true, ..Prefs::default() }, true);
    assert!(diff.restart_needed);
}

#[test]
fn enabling_the_lan_listener_needs_a_native_yes_only_on_the_off_to_on_change() {
    assert_eq!(gate_host_api_tls(false, Some(true), || false).unwrap_err().code, "cancelled");
    assert!(gate_host_api_tls(false, Some(true), || true).is_ok());
    assert!(gate_host_api_tls(true, Some(true), || panic!("already on")).is_ok());
    assert!(gate_host_api_tls(true, Some(false), || panic!("turning off")).is_ok());
    assert!(gate_host_api_tls(false, None, || panic!("untouched")).is_ok());
}

#[test]
fn set_prefs_without_a_data_dir_keeps_the_change_for_the_session() {
    let _guard = prefs_guard();
    let v = apply(PrefsPatch { learn: Some(true), ..Default::default() }).unwrap();
    assert!(v.stored.learn && v.restart_needed);
    let _ = apply(PrefsPatch { learn: Some(false), ..Default::default() });
}

#[test]
fn the_terminal_gate_needs_both_the_env_and_the_pref() {
    // `terminal_enabled` reads the launch snapshot (defaults in unit tests: terminal on); the pure part is `effective_features`.
    let on = |env: Option<&str>, pref: bool| crate::pty::feature_enabled(effective_features(env, pref).as_deref(), "terminal");
    assert!(on(None, true));
    assert!(!on(None, false), "the pref turns it off with no env");
    assert!(!on(Some("agent_chat,file_explorer"), true), "the env without terminal keeps it off");
    assert!(!on(Some("agent_chat,terminal"), false), "the pref wins over the env");
    assert!(on(Some("agent_chat,terminal"), true));
    assert!(terminal_enabled(None), "default launch: on");
}

#[test]
fn a_newer_file_with_unknown_keys_keeps_every_known_preference() {
    let d = tmp("newer-file");
    let text = r#"{"router":true,"theme":"light","backendPort":3999,"futureKey":{"a":1},
        "remoteServer":{"hubUrl":"https://hub.example.com:8443","futureNested":1},"notifications":{"tasks":false,"later":true}}"#;
    std::fs::write(d.join(FILE_NAME), text).unwrap();
    let p = load_from(&d);
    assert!(p.router && p.theme == Theme::Light && p.backend_port == 3999);
    assert!(!p.notifications.tasks);
    assert_eq!(p.remote_server.hub_url, "https://hub.example.com:8443");
    assert!(!d.read_dir().unwrap().flatten().any(|e| e.file_name().to_string_lossy().contains("unreadable")));
}

#[test]
fn an_unparseable_file_is_copied_aside_before_defaults_can_overwrite_it() {
    let d = tmp("unreadable");
    let text = r#"{"router":"yes please"}"#;
    std::fs::write(d.join(FILE_NAME), text).unwrap();
    assert_eq!(load_from(&d), Prefs::default());
    let aside: Vec<_> = d.read_dir().unwrap().flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with("prefs.json.unreadable-")).collect();
    assert_eq!(aside.len(), 1);
    assert_eq!(std::fs::read_to_string(aside[0].path()).unwrap(), text);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(aside[0].path()).unwrap().permissions().mode() & 0o777, 0o600);
    }
    apply_to_dir_for_test(&d);
    assert_eq!(std::fs::read_to_string(aside[0].path()).unwrap(), text, "a later save leaves the copy alone");
}

fn apply_to_dir_for_test(dir: &Path) {
    save_to(dir, &Prefs::default()).unwrap();
}
