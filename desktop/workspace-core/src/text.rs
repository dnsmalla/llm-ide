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
