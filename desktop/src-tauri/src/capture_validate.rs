//! Caption content rules: port of extension/src/content/caption-validation.ts, pinned by shared fixture.
use regex::Regex;
use std::sync::OnceLock;
pub const UNKNOWN_SPEAKER: &str = "Unknown";
pub type Line = (String, String);
const MAX_SPEAKER_UNITS: usize = 50;
const MAX_TEXT_UNITS: usize = 2000;
const BS: &str = r"(?:^|[^A-Za-z0-9_])";
const BE: &str = r"(?:$|[^A-Za-z0-9_])";
const UI_WORD_ALTS: &str = r"present|mute|unmute|camera|more|chat|people|raise|record|share|hang|info|meeting|host|leave|call|keyboard|audio|video|back_hand|mood|apps|lock|closed_caption|format_size|circle|font|settings|open|turn|send|language|japanese|english|live captions|frame_person|visual_effects|reframe|backgrounds|effects|filters|appearance|touch|framing|portrait|blur|lighting|your\s+meeting|dial-in|joining\s+info|attachments|share\s+this|meeting\s+link|meeting\s+code|loading\s+invitees|contributors|just\s+you|[0-9]+\s+joined|save\s+transcript|ask\s+tactiq|chevron_right|chevron_left|expand_more|expand_less|content_copy|return\s+to\s+home|submit\s+feedback|in\s+the\s+meeting|your\s+meet\s+call|secure\s+video|video\s+conferencing|new\s+meeting|enter\s+a\s+code|connect.*collaborate|from\s+your\s+google";
const UI_SEP_ALTS: &str = r"ume-|pm\s|am\s|close\s|pin:|copy\s|add\s";
const ICON_TOKENS: &str = "frame_person|visual_effects|closed_caption|format_size|keyboard_arrow|more_vert|call_end|back_hand|lock_person|stop_circle|chevron_right|chevron_left|expand_more|expand_less|content_copy|arrow_back|arrow_forward|open_in_new|check_circle|navigate_next|navigate_before";
const ICON_WORDS: &str = "mic|videocam|computer|reaction|settings|chat|apps|info|mood|raise|filter|cancel";
struct Rules { ui: Regex, icon_token: Regex, icon_word: Regex, banner: Regex, clock: Regex, meet_id: Regex, turn: Regex, phone: Regex, video_call: Regex, snake_speaker: Regex, digits: Regex, combined: Regex, combined_ja: Regex, control: Regex, ws: Regex }
fn rules() -> &'static Rules { static R: OnceLock<Rules> = OnceLock::new(); R.get_or_init(|| { let r = |p: &str| Regex::new(p).expect("caption regex"); Rules {
 ui: r(&format!(r"(?i)^(?:(?:{UI_WORD_ALTS}){BE}|(?:{UI_SEP_ALTS}))")), icon_token: r(&format!(r"(?i){BS}(?:{ICON_TOKENS}){BE}")), icon_word: r(&format!(r"(?i){BS}(?:{ICON_WORDS}){BE}")),
 banner: r(r"(?i)^(?:connect.*collaborate|from\s+your\s+google)"), clock: r(r"^[0-9]{1,2}:[0-9]{2}"), meet_id: r(r"(?i)^[a-z]{3}-[a-z]{4}-[a-z]{3}"),
 turn: r(&format!(r"(?i){BS}turn (?:off|on){BE}")), phone: r(r"\+[0-9]{1,3}[\s-]?[0-9]"), video_call: r(&format!(r"(?i){BS}video_call{BE}|{BS}keyboard[^A-Za-z0-9_](?:.*[^A-Za-z0-9_])?Join{BE}")), snake_speaker: r(&format!(r"{BS}[a-z]+_[a-z]+{BE}")), digits: r(r"^[0-9]{1,3}$"),
 combined: r(&format!(r"(?i)\s*[&＆]\s*[0-9]+\s*(?:others?|more){BE}.*$")), combined_ja: r(r"\s*(?:他|ほか)\s*[0-9]+(?:$|[^A-Za-z0-9_]).*$"), control: r(r"[\x00-\x1F\x7F]"), ws: r(r"\s+") } }) }
fn units(s: &str) -> usize { s.encode_utf16().count() }
fn truncate_units(s: &str, max: usize) -> String { let mut n=0; let mut o=String::new(); for c in s.chars(){ n+=c.len_utf16(); if n>max{break} o.push(c) } o }
pub fn sanitize_speaker(raw: &str) -> String { let r=rules(); let s=r.control.replace_all(raw," "); let s=r.combined.replace(&s,""); let s=r.combined_ja.replace(&s,""); let s=r.ws.replace_all(&s," "); truncate_units(s.trim(),MAX_SPEAKER_UNITS).trim().to_string() }
pub fn sanitize_text(raw: &str) -> String { let r=rules(); let s=r.control.replace_all(raw," "); let s=r.ws.replace_all(&s," "); truncate_units(s.trim(),MAX_TEXT_UNITS) }
fn looks_like_ui_label(t:&str)->bool{ let t=t.trim(); rules().ws.split(t).count()<=5 && !t.ends_with(['.','?','!','…','。','？','！']) }
fn is_snake_word(w:&str)->bool{ match w.split_once('_'){ Some((a,b))=> !a.is_empty()&&!b.is_empty()&&a.bytes().all(|c|c.is_ascii_alphabetic())&&b.bytes().all(|c|c.is_ascii_alphabetic()), None=>false } }
pub fn is_valid_caption(speaker:&str,text:&str)->bool{ let r=rules(); let (su,tu)=(units(speaker),units(text)); if su<1||su>MAX_SPEAKER_UNITS||tu<1||tu>MAX_TEXT_UNITS{return false}
 if r.ui.is_match(speaker)||r.icon_token.is_match(speaker)||r.icon_word.is_match(speaker)||r.clock.is_match(speaker)||r.meet_id.is_match(speaker)||r.ws.split(speaker).count()>5{return false}
 if r.icon_token.is_match(text)||r.banner.is_match(text){return false}
 if looks_like_ui_label(text)&&(r.ui.is_match(text)||r.icon_word.is_match(text)||r.turn.is_match(text)){return false}
 if r.phone.is_match(text)||r.video_call.is_match(text)||r.snake_speaker.is_match(speaker){return false}
 if r.ws.split(text).all(is_snake_word){return false}
 !r.digits.is_match(text.trim()) }
pub fn clean_lines(lines:Vec<Line>)->Vec<Line>{ lines.into_iter().filter_map(|(s,t)|{ let mut s=sanitize_speaker(&s); if s.is_empty(){s=UNKNOWN_SPEAKER.into()} let t=sanitize_text(&t); is_valid_caption(&s,&t).then_some((s,t)) }).collect() }
#[cfg(test)] mod tests { use super::*; use serde_json::Value; fn cases()->Value{serde_json::from_str(include_str!("../tests/fixtures/captions/validation-cases.json")).unwrap()}
 #[test] fn sanitize(){for c in cases()["sanitize"].as_array().unwrap(){assert_eq!(sanitize_speaker(c["in"].as_str().unwrap()),c["out"].as_str().unwrap(),"{c}")}}
 #[test] fn valid(){for c in cases()["valid"].as_array().unwrap(){assert_eq!(is_valid_caption(c["speaker"].as_str().unwrap(),c["text"].as_str().unwrap()),c["valid"].as_bool().unwrap(),"{c}")}}
 #[test] fn clean(){assert_eq!(clean_lines(vec![("  ".into(),"Thanks, everyone.".into()),("Alice & 2 others".into(),"Hello\nthere.".into()),("Unknown".into(),"Turn off captions".into())]),vec![("Unknown".into(),"Thanks, everyone.".into()),("Alice".into(),"Hello there.".into())])}
 #[test] fn cap(){let t=sanitize_text(&"word ".repeat(600)); assert!(units(&t)<=2000); assert!(is_valid_caption("Alice",&t));}}
