//! Single-line text helpers. They are pure, so the notification code, the confirmation dialogs and the core
//! crate share one definition of what counts as a control or invisible character.

/// Invisible "format" characters (Unicode Cf): bidi overrides/isolates, zero-width
/// joiners, BOM, tag characters. They can reorder or hide text in a notification.
pub fn is_invisible_format(c: char) -> bool {
    matches!(c,
        '\u{00AD}' | '\u{061C}' | '\u{180E}' | '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}'
        | '\u{2060}'..='\u{206F}' | '\u{FEFF}' | '\u{FFF9}'..='\u{FFFB}' | '\u{E0000}'..='\u{E007F}')
}

/// Single line of plain text: control and invisible format characters (bidi overrides,
/// zero-width joiners, BOM, tag characters) are dropped, whitespace runs collapse to one
/// space, capped at `max` characters.
pub fn sanitize_line(s: &str, max: usize) -> String {
    let mut out = String::new();
    let mut gap = false;
    for c in s.chars() {
        if c.is_whitespace() || c.is_control() {
            gap = !out.is_empty();
            continue;
        }
        if is_invisible_format(c) {
            continue;
        }
        if gap {
            out.push(' ');
            gap = false;
        }
        out.push(c);
        if out.chars().count() >= max {
            break;
        }
    }
    out.chars().take(max).collect()
}

/// `secs` since the epoch as `YYYY-MM-DDTHH:MM:SSZ` (proleptic Gregorian, UTC, no dependency). Negative times are
/// before 1970. This is the one date formatter of the desktop, the helper and the project marker.
pub fn format_rfc3339_utc(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // Howard Hinnant's civil-from-days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, (rem % 3600) / 60, rem % 60)
}

/// Display names of folders are capped (tray label, UI).
pub const FOLDER_NAME_MAX_CHARS: usize = 60;

/// The name the app shows for a project folder: its last component without control characters, at most
/// `FOLDER_NAME_MAX_CHARS`. A path with no usable last component shows as `project`. The desktop and the helper both
/// use it, so a folder reads the same whichever side opened it.
pub fn folder_display_name(root: &std::path::Path) -> String {
    let name = root.file_name().and_then(|n| n.to_str()).unwrap_or("project");
    name.chars().filter(|c| !c.is_control()).take(FOLDER_NAME_MAX_CHARS).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates_are_utc_and_exact() {
        assert_eq!(format_rfc3339_utc(0), "1970-01-01T00:00:00Z");
        assert_eq!(format_rfc3339_utc(1_700_000_000), "2023-11-14T22:13:20Z");
        assert_eq!(format_rfc3339_utc(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(format_rfc3339_utc(1_793_448_000), "2026-10-31T12:00:00Z");
        assert_eq!(format_rfc3339_utc(1_709_251_199), "2024-02-29T23:59:59Z");
        assert_eq!(format_rfc3339_utc(-1), "1969-12-31T23:59:59Z");
    }

    #[test]
    fn folder_names_are_capped_and_clean() {
        let long = format!("/x/{}", "a".repeat(200));
        assert_eq!(folder_display_name(std::path::Path::new(&long)).chars().count(), FOLDER_NAME_MAX_CHARS);
        assert_eq!(folder_display_name(std::path::Path::new("/x/a\u{7}b\nc")), "abc");
        assert_eq!(folder_display_name(std::path::Path::new("/")), "project");
    }
}
