use super::*;

#[test]
fn loop_defaults_round_trip_and_clamp_the_policy() {
    let d = LoopDefaults {
        max_iterations: 2, consecutive_failure_stop: 1, wall_clock_minutes: 15,
        max_repairs_per_stage: 0, pause_timeout_minutes: 0,
        protected_path_policy: "bogus".to_string(), write_summary_note: true,
    };
    let p = Prefs::default().patched(&PrefsPatch { loop_defaults: Some(d), ..Default::default() });
    assert_eq!(p.loop_defaults.max_iterations, 2);
    assert_eq!(p.loop_defaults.protected_path_policy, "revert");
    assert!(p.loop_defaults.write_summary_note);
    let back = parse(&serde_json::to_string(&p).unwrap());
    assert_eq!(back.loop_defaults, p.loop_defaults);
}

#[test]
fn loop_defaults_clamp_every_bound() {
    let d = LoopDefaults {
        max_iterations: 0, consecutive_failure_stop: 99, wall_clock_minutes: 99_999,
        max_repairs_per_stage: 999, pause_timeout_minutes: 999,
        protected_path_policy: "off".to_string(), write_summary_note: false,
    };
    let p = Prefs::default().patched(&PrefsPatch { loop_defaults: Some(d), ..Default::default() });
    assert_eq!(p.loop_defaults.max_iterations, 1);
    assert_eq!(p.loop_defaults.consecutive_failure_stop, 20);
    assert_eq!(p.loop_defaults.wall_clock_minutes, 1440);
    assert_eq!(p.loop_defaults.max_repairs_per_stage, 20);
    assert_eq!(p.loop_defaults.pause_timeout_minutes, 240);
    assert_eq!(p.loop_defaults.protected_path_policy, "off");
    let high = LoopDefaults { max_iterations: 500, consecutive_failure_stop: 0, ..LoopDefaults::default() };
    let q = Prefs::default().patched(&PrefsPatch { loop_defaults: Some(high), ..Default::default() });
    assert_eq!(q.loop_defaults.max_iterations, 3);
    assert_eq!(q.loop_defaults.consecutive_failure_stop, 1);
}

#[test]
fn update_checks_default_on_patchable_and_never_need_a_restart() {
    assert!(Prefs::default().update_checks);
    let off = Prefs::default().patched(&PrefsPatch { update_checks: Some(false), ..Default::default() });
    assert!(!off.update_checks);
    assert!(!parse(&serde_json::to_string(&off).unwrap()).update_checks);
    // An old file without the key keeps the default.
    assert!(parse(r#"{"ltaMode":"off"}"#).update_checks);
}

#[test]
fn graph_auto_update_is_off_or_between_five_and_a_day() {
    let mut p = Prefs::default();
    assert_eq!(p.graph_auto_update_minutes, 0);
    p = p.patched(&PrefsPatch { graph_auto_update_minutes: Some(1), ..Default::default() });
    assert_eq!(p.graph_auto_update_minutes, 5);
    p = p.patched(&PrefsPatch { graph_auto_update_minutes: Some(99_999), ..Default::default() });
    assert_eq!(p.graph_auto_update_minutes, 1440);
    p = p.patched(&PrefsPatch { graph_auto_update_minutes: Some(0), ..Default::default() });
    assert_eq!(p.graph_auto_update_minutes, 0);
    let back = parse(&serde_json::to_string(&p).unwrap());
    assert_eq!(back.graph_auto_update_minutes, 0);
}

#[test]
fn notification_switches_default_on_patch_whole_and_never_need_a_restart() {
    assert_eq!(Prefs::default().notifications, NotifyPrefs::default());
    let d = NotifyPrefs::default(); assert!(d.approvals && d.tasks && d.sync && d.updates && d.core);
    let off = NotifyPrefs { tasks: false, ..NotifyPrefs::default() };
    let p = Prefs::default().patched(&PrefsPatch { notifications: Some(off), ..Default::default() });
    assert_eq!(p.notifications, off);
    assert_eq!(parse(&serde_json::to_string(&p).unwrap()).notifications, off);
    assert!(parse(r#"{"ltaMode":"off"}"#).notifications.approvals, "an old file keeps the defaults");
    assert!(!parse(r#"{"notifications":{"approvals":false,"evil":true}}"#).notifications.approvals, "a nested unknown key is ignored too");
    assert!(serde_json::from_str::<PrefsPatch>(r#"{"notifications":{"approvals":false,"evil":true}}"#).is_err(), "the webview patch stays strict");
    assert!(serde_json::from_str::<PrefsPatch>(r#"{"notifications":{"approvals":"no"}}"#).is_err());
    assert!(!view(Prefs { notifications: off, ..Prefs::default() }, true).restart_needed, "applies at once");
}
