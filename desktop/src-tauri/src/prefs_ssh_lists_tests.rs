use super::*;
use base64::Engine as _;

fn b64(seed: &str) -> String {
    base64::engine::general_purpose::STANDARD.encode(seed.as_bytes())
}

/// The canonical saved pin for a host, port and seed.
fn pin(host: &str, port: u16, seed: &str) -> String {
    format!("{host}:{port} ssh-ed25519 {}", b64(seed))
}

/// Clears the stored SSH block and holds the preferences lock for the whole test.
fn fresh() -> std::sync::MutexGuard<'static, ()> {
    let guard = prefs_guard();
    set_remote_server_for_test(RemoteServerPrefs::default());
    guard
}

fn stored_block() -> RemoteServerPrefs {
    stored().remote_server
}

/// Switches SSH mode to a server with key auth, the same write a successful connect makes.
fn switch_to(host: &str, port: u16, user: &str) {
    set_remote_ssh(host.into(), port, user.into(), "/home/u/.ssh/id".into(), SshAuthKind::Key, ServerMode::Ssh).unwrap();
}

fn recent(host: &str, user: &str) -> SshRecentServer {
    SshRecentServer { host: host.into(), port: 22, user: user.into(), key_path: String::new(), auth: SshAuthKind::Password, last_used: 5 }
}

#[test]
fn old_single_pin_migrates_into_the_list() {
    let legacy = format!("Example.com:22 ssh-ed25519 {}", b64("key-a"));
    let file = format!(r#"{{"remoteServer":{{"mode":"ssh","host":"example.com","port":22,"user":"alice","keyPath":"/k","sshHostPin":"{legacy}"}}}}"#);
    let loaded = parse(&file);
    assert_eq!(loaded.remote_server.ssh_known_hosts, vec![pin("example.com", 22, "key-a")]);
    assert_eq!(loaded.remote_server.ssh_host_pin, "", "the legacy field is cleared on load");
}

#[test]
fn the_migrated_pin_replaces_a_listed_pin_for_the_same_endpoint() {
    let legacy = format!("example.com:22 ssh-ed25519 {}", b64("new"));
    let file = format!(r#"{{"remoteServer":{{"sshKnownHosts":["{}"],"sshHostPin":"{legacy}"}}}}"#, pin("example.com", 22, "old"));
    let loaded = parse(&file);
    assert_eq!(loaded.remote_server.ssh_known_hosts, vec![legacy], "one pin per host and port, the migrated one wins");
}

#[test]
fn one_pin_per_host_and_port() {
    let _guard = fresh();
    upsert_ssh_known_host(format!("EXAMPLE.com:22 ssh-ed25519 {}", b64("key-a"))).unwrap();
    upsert_ssh_known_host(pin("example.com", 22, "key-b")).unwrap();
    upsert_ssh_known_host(pin("example.com", 2222, "key-a")).unwrap();
    assert_eq!(stored_block().ssh_known_hosts, vec![pin("example.com", 22, "key-b"), pin("example.com", 2222, "key-a")]);
}

#[test]
fn the_list_holds_at_most_32_pins_and_drops_the_oldest() {
    let _guard = fresh();
    for port in 1..=(SSH_KNOWN_HOSTS_MAX as u16 + 1) {
        upsert_ssh_known_host(pin("example.com", port, "key-a")).unwrap();
    }
    let list = stored_block().ssh_known_hosts;
    assert_eq!(list.len(), SSH_KNOWN_HOSTS_MAX);
    assert!(!list.iter().any(|entry| entry.starts_with("example.com:1 ")), "the oldest pin is the one dropped");
    assert!(list.last().unwrap().starts_with("example.com:33 "));
}

#[test]
fn an_invalid_pin_is_refused_on_write() {
    let _guard = fresh();
    assert_eq!(upsert_ssh_known_host("nonsense".into()).unwrap_err().code, "invalid_host_key");
    assert_eq!(upsert_ssh_known_host(pin("example.com", 0, "key-a")).unwrap_err().code, "invalid_host_key");
    assert_eq!(upsert_ssh_known_host("example.com:22 ssh-ed25519 !!!".into()).unwrap_err().code, "invalid_host_key");
    assert!(stored_block().ssh_known_hosts.is_empty());
}

#[test]
fn an_invalid_or_oversized_list_entry_is_dropped_on_load_never_cut() {
    let good = pin("example.com", 22, "key-a");
    let over = format!("example.com:2222 ssh-rsa {}", "A".repeat(SSH_HOST_PIN_MAX));
    let file = serde_json::json!({ "remoteServer": { "sshKnownHosts": [
        good, "not a pin", over, "example.com:0 ssh-ed25519 AAAA", "example.com:3333 ssh-ed25519 !!!", "example.com:4444 bogus AAAA",
    ] } })
    .to_string();
    assert_eq!(parse(&file).remote_server.ssh_known_hosts, vec![good]);
}

#[test]
fn recent_servers_are_capped_ordered_and_keyed_without_case() {
    let _guard = fresh();
    for i in 0..12 {
        switch_to(&format!("host{i}.example.com"), 22, "alice");
    }
    let recent_list = stored_block().ssh_recent_servers;
    assert_eq!(recent_list.len(), SSH_RECENT_SERVERS_MAX);
    assert_eq!(recent_list[0].host, "host11.example.com");
    assert_eq!(recent_list[9].host, "host2.example.com");
    assert!(recent_list.iter().all(|server| server.last_used > 0));

    // The same server typed in capitals moves to the front and is not a second entry.
    switch_to("HOST5.example.com", 22, "alice");
    let recent_list = stored_block().ssh_recent_servers;
    assert_eq!(recent_list.len(), SSH_RECENT_SERVERS_MAX);
    assert_eq!(recent_list[0].host, "host5.example.com");
    assert_eq!(recent_list.iter().filter(|server| server.host == "host5.example.com").count(), 1);

    // Another user on the same host is another server, and the oldest one is pushed out.
    switch_to("host5.example.com", 22, "bob");
    let recent_list = stored_block().ssh_recent_servers;
    assert_eq!(recent_list.len(), SSH_RECENT_SERVERS_MAX);
    assert_eq!(recent_list[0].user, "bob");
    assert_eq!(recent_list.iter().filter(|server| server.host == "host5.example.com").count(), 2);
}

#[test]
fn a_recent_server_has_the_wire_fields_and_no_secret() {
    let value = serde_json::to_value(SshRecentServer {
        host: "example.com".into(), port: 22, user: "alice".into(), key_path: "/k".into(), auth: SshAuthKind::Password, last_used: 7,
    })
    .unwrap();
    assert_eq!(value, serde_json::json!({ "host": "example.com", "port": 22, "user": "alice", "keyPath": "/k", "auth": "password", "lastUsed": 7 }));
}

#[test]
fn folders_are_capped_per_server_and_their_paths_checked() {
    let _guard = fresh();
    switch_to("example.com", 22, "alice");
    switch_to("other.example", 22, "alice");
    let first = "alice@example.com:22";
    let second = "alice@other.example:22";
    for i in 0..12 {
        record_ssh_recent_folder(first, &format!("/home/alice/p{i}")).unwrap();
    }
    let paths = ssh_recent_folders(first);
    assert_eq!(paths.len(), SSH_RECENT_FOLDERS_MAX);
    assert_eq!(paths[0], "/home/alice/p11");
    assert_eq!(paths[9], "/home/alice/p2");
    record_ssh_recent_folder(second, "/srv/app").unwrap();
    assert_eq!(ssh_recent_folders(first).len(), SSH_RECENT_FOLDERS_MAX, "another server's folder does not push these out");
    assert_eq!(ssh_recent_folders(second), vec!["/srv/app".to_string()]);

    for bad in ["relative/path", "", "/a\nb", "/a\rb", "/a\0b"] {
        assert_eq!(record_ssh_recent_folder(first, bad).unwrap_err().code, "invalid_path", "{bad:?}");
    }
    let too_long = format!("/{}", "x".repeat(SSH_FOLDER_PATH_MAX));
    assert_eq!(record_ssh_recent_folder(first, &too_long).unwrap_err().code, "invalid_path");
    let longest = format!("/{}", "x".repeat(SSH_FOLDER_PATH_MAX - 1));
    record_ssh_recent_folder(first, &longest).unwrap();
    assert_eq!(ssh_recent_folders(first)[0], longest);
    forget_ssh_recent_folder(first, &longest).unwrap();
    assert!(!ssh_recent_folders(first).contains(&longest), "a forgotten folder is gone");
    assert_eq!(record_ssh_recent_folder("carol@example.com:22", "/x").unwrap_err().code, "unknown_server");
}

#[test]
fn a_server_pushed_out_of_the_recent_list_takes_its_folders() {
    let _guard = fresh();
    switch_to("example.com", 22, "alice");
    record_ssh_recent_folder("alice@example.com:22", "/home/alice/a").unwrap();
    for i in 0..SSH_RECENT_SERVERS_MAX {
        switch_to(&format!("h{i}.example.com"), 22, "alice");
    }
    assert!(ssh_recent_folders("alice@example.com:22").is_empty());
    assert!(stored_block().ssh_recent_folders.is_empty());
}

#[test]
fn forget_keeps_the_pin_while_another_saved_server_uses_it() {
    let _guard = fresh();
    upsert_ssh_known_host(pin("example.com", 22, "key-a")).unwrap();
    switch_to("example.com", 22, "alice");
    switch_to("example.com", 22, "bob");
    record_ssh_recent_folder("alice@example.com:22", "/home/alice/a").unwrap();
    record_ssh_recent_folder("bob@example.com:22", "/home/bob/b").unwrap();

    forget_ssh_server("example.com", 22, "alice").unwrap();
    let block = stored_block();
    assert_eq!(block.ssh_recent_servers.iter().map(|s| s.user.as_str()).collect::<Vec<_>>(), ["bob"]);
    assert!(ssh_recent_folders("alice@example.com:22").is_empty());
    assert_eq!(ssh_recent_folders("bob@example.com:22"), ["/home/bob/b"], "another user's folders stay");
    assert_eq!(block.ssh_known_hosts, vec![pin("example.com", 22, "key-a")], "bob still needs the same host key");
}

#[test]
fn forget_removes_the_pin_and_folders_once_no_saved_server_uses_them() {
    let _guard = fresh();
    upsert_ssh_known_host(pin("example.com", 22, "key-a")).unwrap();
    upsert_ssh_known_host(pin("other.example", 22, "key-b")).unwrap();
    switch_to("example.com", 22, "bob");
    record_ssh_recent_folder("bob@example.com:22", "/home/bob/b").unwrap();
    switch_to("elsewhere.example", 22, "carol");

    forget_ssh_server("example.com", 22, "bob").unwrap();
    let block = stored_block();
    assert_eq!(block.ssh_known_hosts, vec![pin("other.example", 22, "key-b")], "only the unused endpoint's key goes");
    assert!(ssh_recent_folders("bob@example.com:22").is_empty());
    assert_eq!((block.host.as_str(), block.user.as_str()), ("elsewhere.example", "carol"), "the switch is not touched");
}

/// A saved SSH server with every field set, so a test can see each one survive a launch.
fn saved_ssh_server() -> RemoteServerPrefs {
    RemoteServerPrefs {
        mode: ServerMode::Ssh,
        host: "example.com".into(),
        port: 2222,
        user: "alice".into(),
        key_path: "/home/alice/.ssh/id".into(),
        ssh_auth: SshAuthKind::Password,
        ssh_known_hosts: vec![pin("example.com", 2222, "key-a")],
        ssh_recent_servers: vec![recent("example.com", "alice")],
        ssh_recent_folders: vec![SshRecentFolder { server: "alice@example.com:2222".into(), path: "/home/alice".into(), last_used: 3 }],
        ..RemoteServerPrefs::default()
    }
}

#[test]
fn a_launch_in_ssh_mode_runs_ssh_and_saves_local_with_the_server_intact() {
    let _guard = fresh();
    let saved = saved_ssh_server();
    set_remote_server_for_test(saved.clone());
    assert_eq!(end_ssh_session_at_launch(ServerMode::Ssh), ServerMode::Ssh, "this session runs in SSH");
    assert_eq!(
        stored().remote_server,
        RemoteServerPrefs { mode: ServerMode::Local, ..saved },
        "the next start is local; host, port, user, pins and recents are untouched",
    );
}

#[test]
fn a_launch_in_hub_mode_stays_remote() {
    let _guard = fresh();
    let hub = RemoteServerPrefs {
        mode: ServerMode::Remote,
        hub_url: "https://hub.example.com".into(),
        tls_pin: "sha256:AAAA".into(),
        ..RemoteServerPrefs::default()
    };
    set_remote_server_for_test(hub.clone());
    assert_eq!(end_ssh_session_at_launch(ServerMode::Remote), ServerMode::Remote);
    assert_eq!(stored().remote_server, hub, "hub mode is persistent and changes nothing");
}

#[test]
fn a_launch_in_local_mode_stays_local_and_keeps_a_saved_server() {
    let _guard = fresh();
    let saved = RemoteServerPrefs { mode: ServerMode::Local, ..saved_ssh_server() };
    set_remote_server_for_test(saved.clone());
    assert_eq!(end_ssh_session_at_launch(ServerMode::Local), ServerMode::Local);
    assert_eq!(stored().remote_server, saved, "a local start changes nothing");
}

#[test]
fn forgetting_the_switched_to_server_leaves_the_switch_and_its_key() {
    let _guard = fresh();
    upsert_ssh_known_host(pin("example.com", 22, "key-a")).unwrap();
    switch_to("example.com", 22, "bob");
    forget_ssh_server("example.com", 22, "bob").unwrap();
    let block = stored_block();
    assert_eq!((block.mode, block.host.as_str(), block.user.as_str()), (ServerMode::Ssh, "example.com", "bob"));
    assert!(block.ssh_recent_servers.is_empty());
    assert_eq!(block.ssh_known_hosts, vec![pin("example.com", 22, "key-a")], "the switched-to server still needs its key");
    forget_ssh_server("never.example", 22, "dave").unwrap();
}

#[test]
fn a_webview_patch_cannot_touch_the_three_lists() {
    let mut base = Prefs::default();
    base.remote_server.ssh_known_hosts = vec![pin("example.com", 22, "key-a")];
    base.remote_server.ssh_recent_servers = vec![recent("example.com", "alice")];
    base.remote_server.ssh_recent_folders = vec![SshRecentFolder { server: "alice@example.com:22".into(), path: "/home/alice".into(), last_used: 1 }];
    let patched = base.patched(&PrefsPatch {
        remote_server: Some(RemoteServerPrefs {
            mode: ServerMode::Ssh,
            host: "evil.example.com".into(),
            port: 22,
            user: "u".into(),
            key_path: "/k".into(),
            ssh_known_hosts: vec![pin("evil.example.com", 22, "key-b")],
            ssh_recent_servers: Vec::new(),
            ssh_recent_folders: vec![SshRecentFolder { server: "u@evil.example.com:22".into(), path: "/".into(), last_used: 9 }],
            ..RemoteServerPrefs::default()
        }),
        ..Default::default()
    });
    assert_eq!(patched.remote_server.ssh_known_hosts, base.remote_server.ssh_known_hosts);
    assert_eq!(patched.remote_server.ssh_recent_servers, base.remote_server.ssh_recent_servers);
    assert_eq!(patched.remote_server.ssh_recent_folders, base.remote_server.ssh_recent_folders);
}

#[test]
fn a_full_set_of_lists_is_saved_and_loaded_whole() {
    let _guard = fresh();
    for i in 0..32u16 {
        upsert_ssh_known_host(pin(&format!("h{i}.example.com"), 22, "key-a")).unwrap();
    }
    for i in 0..SSH_RECENT_SERVERS_MAX {
        switch_to(&format!("h{i}.example.com"), 22, "alice");
    }
    for i in 0..SSH_RECENT_SERVERS_MAX {
        let server = format!("alice@h{i}.example.com:22");
        for j in 0..SSH_RECENT_FOLDERS_MAX {
            record_ssh_recent_folder(&server, &format!("/{j:04}{}", "x".repeat(SSH_FOLDER_PATH_MAX - 5))).unwrap();
        }
    }
    let dir = std::env::temp_dir().join(format!("llmide-ssh-lists-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let before = stored().remote_server;
    save_to(&dir, &stored()).unwrap();
    let size = std::fs::metadata(dir.join(FILE_NAME)).unwrap().len();
    let loaded = load_from(&dir).remote_server;
    let _ = std::fs::remove_dir_all(&dir);
    assert!(size > 16 * 1024, "the worst case is larger than the old 16 KB bound");
    assert_eq!(loaded, before, "nothing is dropped at the caps");
}

/// The byte caps at their worst: 4-byte characters fill every folder path to the byte cap, and `"` (the
/// most-escaping allowed character) fills the others, so the file is as large as the caps allow.
#[test]
fn a_worst_case_of_non_ascii_and_escaped_text_is_saved_whole() {
    let _guard = fresh();
    let label = "a".repeat(63);
    for i in 0..32u16 {
        // A full-length pin: 2048 bytes of ASCII base64 on one line, the longest the cap admits.
        let head = format!("h{i}.example.com:22 ssh-ed25519 ");
        let blob = "A".repeat((SSH_HOST_PIN_MAX - head.len()) / 4 * 4);
        upsert_ssh_known_host(format!("{head}{blob}")).unwrap();
    }
    for i in 0..SSH_RECENT_SERVERS_MAX {
        // A 253-byte host and a 64-byte user, the longest the validators admit.
        let host = format!("{label}.{label}.{label}.{i:02}{}", "z".repeat(59));
        // A key path of `"` fills the 4096-byte cap; each `"` is escaped to two bytes in the file.
        set_remote_ssh(host.clone(), 22, "a".repeat(64), format!("/{}", "\"".repeat(4095)), SshAuthKind::Key, ServerMode::Ssh).unwrap();
        let server = format!("{}@{host}:22", "a".repeat(64));
        for j in 0..SSH_RECENT_FOLDERS_MAX {
            // Even folders: 4-byte characters (1 + 1023 * 4 + 1 + 2 digits = 4096 bytes). Odd: `"` (4096 bytes).
            let path = if j % 2 == 0 {
                format!("/{j:02}{}x", "\u{1F600}".repeat(1023))
            } else {
                format!("/{j:02}{}", "\"".repeat(4093))
            };
            assert_eq!(path.len(), SSH_FOLDER_PATH_MAX, "the test fills the byte cap");
            record_ssh_recent_folder(&server, &path).unwrap();
        }
    }
    // 1024 four-byte characters are 4097 bytes but only 1024 characters: the cap counts bytes.
    let server = format!("{}@{}:22", "a".repeat(64), format!("{label}.{label}.{label}.00{}", "z".repeat(59)));
    assert_eq!(record_ssh_recent_folder(&server, &format!("/{}", "\u{1F600}".repeat(1024))).unwrap_err().code, "invalid_path");
    let dir = std::env::temp_dir().join(format!("llmide-ssh-worst-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let before = stored().remote_server;
    save_to(&dir, &stored()).unwrap();
    let size = std::fs::metadata(dir.join(FILE_NAME)).unwrap().len() as usize;
    let loaded = load_from(&dir).remote_server;
    let _ = std::fs::remove_dir_all(&dir);
    assert!(size > 512 * 1024 && size <= MAX_BYTES, "a worst-case file fits the cap: {size} bytes");
    assert_eq!(loaded, before, "nothing is dropped at the byte caps");
}
