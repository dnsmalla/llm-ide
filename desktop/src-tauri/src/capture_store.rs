//! Crash-safe capture partial and the verified meeting note, in the Mac MeetingFileStore format.
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use regex::Regex;
use serde::{Deserialize, Serialize};
use crate::notes_write;

pub const PARTIAL_SUFFIX: &str = ".partial.md";
const SYNC_EVERY: Duration = Duration::from_secs(2);
const MAX_TITLE_CHARS: usize = 300;
const MAX_PARTIAL_BYTES: u64 = 64 * 1024 * 1024;
const MAX_RECOVERY_LIST: usize = 50;
const INDEX_BODY_BYTES: usize = 512 * 1024;
fn io(e: std::io::Error) -> String { format!("io: {e}") }

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartialHeader { pub v: u32, pub id: String, pub started_at_ms: i64, pub language: String, pub notes_root: String }
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Row { pub time: String, pub speaker: String, pub text: String }
pub fn render_line(r: &Row) -> String { format!("[{}] **{}**: {}", r.time, r.speaker, r.text) }
fn line_re() -> &'static Regex { static R: std::sync::OnceLock<Regex> = std::sync::OnceLock::new(); R.get_or_init(|| Regex::new(r"^\[(\d{2}:\d{2}:\d{2})\] \*\*(.+?)\*\*: (.*)$").expect("static")) }

fn base36(mut n: u64) -> String { const D:&[u8]=b"0123456789abcdefghijklmnopqrstuvwxyz"; if n==0{return "0".into()} let mut v=Vec::new(); while n>0{v.push(D[(n%36) as usize]);n/=36} v.reverse(); String::from_utf8(v).expect("ascii") }
pub fn new_session_id(now_ms: i64) -> String { let mut b=[0u8;8]; let _=getrandom::fill(&mut b); let r=u64::from_le_bytes(b)%36u64.pow(6); format!("m-{}-{:0>6}",base36((now_ms.max(0)/1000) as u64),base36(r)) }
pub fn valid_session_id(id:&str)->bool{let Some(rest)=id.strip_prefix("m-")else{return false};let Some((a,b))=rest.split_once('-')else{return false};let ok=|s:&str,max:usize|!s.is_empty()&&s.len()<=max&&s.bytes().all(|c|c.is_ascii_digit()||c.is_ascii_lowercase());ok(a,13)&&ok(b,8)}

pub struct PartialWriter { path: PathBuf, file: File, last_sync: Instant }
impl PartialWriter {
 pub fn create(dir:&Path,h:&PartialHeader)->Result<Self,String>{if !valid_session_id(&h.id){return Err("invalid_id: bad session id".into())}std::fs::create_dir_all(dir).map_err(io)?;let path=dir.join(format!("{}{PARTIAL_SUFFIX}",h.id));let mut opts=OpenOptions::new();opts.write(true).create_new(true);#[cfg(unix)]{use std::os::unix::fs::OpenOptionsExt;opts.mode(0o600).custom_flags(libc::O_NOFOLLOW);}let mut file=opts.open(&path).map_err(io)?;let head=serde_json::to_string(h).map_err(|e|format!("io: {e}"))?;writeln!(file,"{head}").map_err(io)?;file.sync_all().map_err(io)?;Ok(Self{path,file,last_sync:Instant::now()})}
 pub fn path(&self)->&Path{&self.path}
 pub fn append_row(&mut self,r:&Row)->Result<(),String>{writeln!(self.file,"{}",render_line(r)).map_err(io)?;self.maybe_sync()}
 pub fn set_platform(&mut self,p:&str)->Result<(),String>{writeln!(self.file,"{}",serde_json::json!({"platform":p})).map_err(io)?;self.maybe_sync()}
 pub fn sync(&mut self)->Result<(),String>{self.last_sync=Instant::now();self.file.sync_data().map_err(io)}
 fn maybe_sync(&mut self)->Result<(),String>{if self.last_sync.elapsed()>=SYNC_EVERY{self.sync()}else{Ok(())}}
}
#[derive(Debug,Clone,PartialEq)]pub struct Recovered{pub header:PartialHeader,pub platform:Option<String>,pub rows:Vec<Row>}
pub fn read_partial(path:&Path)->Result<Recovered,String>{let meta=std::fs::symlink_metadata(path).map_err(io)?;if !meta.is_file()||meta.len()>MAX_PARTIAL_BYTES{return Err("invalid_partial: not a regular file or too large".into())}let mut lines=BufReader::new(File::open(path).map_err(io)?).lines();let first=lines.next().ok_or("invalid_partial: empty")?.map_err(io)?;let header:PartialHeader=serde_json::from_str(&first).map_err(|e|format!("invalid_partial: {e}"))?;if !valid_session_id(&header.id){return Err("invalid_partial: bad id".into())}let mut platform=None;let mut rows=Vec::new();for line in lines{let line=line.map_err(io)?;if line.starts_with('{'){if let Ok(v)=serde_json::from_str::<serde_json::Value>(&line){if let Some(p)=v.get("platform").and_then(|p|p.as_str()){platform=Some(p.chars().take(20).collect())}}}else if let Some(c)=line_re().captures(&line){rows.push(Row{time:c[1].to_string(),speaker:c[2].to_string(),text:c[3].to_string()})}}Ok(Recovered{header,platform,rows})}

#[derive(Debug,Clone,PartialEq,Serialize)]#[serde(rename_all="camelCase")]pub struct PartialSummary{pub id:String,pub started_at_ms:i64,pub rows:usize}
pub fn partial_path(dir:&Path,id:&str)->Option<PathBuf>{valid_session_id(id).then(||dir.join(format!("{id}{PARTIAL_SUFFIX}")))}
pub fn list_partials(dir:&Path,skip:Option<&str>)->Vec<PartialSummary>{let Ok(rd)=std::fs::read_dir(dir)else{return Vec::new()};let mut out:Vec<_>=rd.flatten().filter_map(|e|{let n=e.file_name().into_string().ok()?;let id=n.strip_suffix(PARTIAL_SUFFIX)?;if !valid_session_id(id)||Some(id)==skip{return None}let r=read_partial(&e.path()).ok()?;Some(PartialSummary{id:id.into(),started_at_ms:r.header.started_at_ms,rows:r.rows.len()})}).collect();out.sort_by(|a,b|b.started_at_ms.cmp(&a.started_at_ms));out.truncate(MAX_RECOVERY_LIST);out}

#[cfg(unix)]fn local_parts(ms:i64)->(i64,u32,u32,u32,u32,u32){let t:libc::time_t=ms.div_euclid(1000) as libc::time_t;let mut tm:libc::tm=unsafe{std::mem::zeroed()};let ok=unsafe{!libc::localtime_r(&t,&mut tm).is_null()};if !ok{return utc_parts(ms)}(tm.tm_year as i64+1900,(tm.tm_mon+1) as u32,tm.tm_mday as u32,tm.tm_hour as u32,tm.tm_min as u32,tm.tm_sec as u32)}
#[cfg(not(unix))]fn local_parts(ms:i64)->(i64,u32,u32,u32,u32,u32){utc_parts(ms)}
fn utc_parts(ms:i64)->(i64,u32,u32,u32,u32,u32){let iso=crate::chat_archive::iso_utc(ms as f64/1000.0);let n=|a:usize,b:usize|iso[a..b].parse::<u32>().unwrap_or(0);(iso[0..4].parse().unwrap_or(1970),n(5,7),n(8,10),n(11,13),n(14,16),n(17,19))}
pub fn local_hms(ms:i64)->String{let(_,_,_,h,mi,s)=local_parts(ms);format!("{h:02}:{mi:02}:{s:02}")}

pub struct FinalMeta<'a>{pub id:&'a str,pub title:&'a str,pub started_at_ms:i64,pub ended_at_ms:i64,pub platform:&'a str,pub language:&'a str}
pub fn clean_title(raw:&str)->String{let t:String=raw.chars().map(|c|if c.is_control(){' '}else{c}).collect();let t:String=t.trim().chars().take(MAX_TITLE_CHARS).collect();if t.trim().is_empty(){"Untitled meeting".into()}else{t.trim().into()}}
fn q(s:&str)->String{serde_json::to_string(s).expect("string")}
fn participants(rows:&[Row])->Vec<String>{let mut p:Vec<String>=rows.iter().map(|r|r.speaker.clone()).collect();p.sort();p.dedup();p}
pub fn render_meeting(m:&FinalMeta,rows:&[Row])->String{let iso=|ms:i64|crate::chat_archive::iso_utc(ms as f64/1000.0);let duration=(m.ended_at_ms-m.started_at_ms).max(0)/1000;let mut out=format!("---\nid: {}\ntitle: {}\nstarted_at: {}\nended_at: {}\nduration_seconds: {}\nparticipants: {}\nplatform: {}\nlanguage: {}\ntldr: []\n---\n\n## Transcript\n\n",q(m.id),q(m.title),q(&iso(m.started_at_ms)),q(&iso(m.ended_at_ms)),duration,serde_json::to_string(&participants(rows)).expect("list"),q(m.platform),q(m.language));for r in rows{out.push_str(&render_line(r));out.push('\n')}out}
pub fn disambiguator(id:&str)->String{let mut h:u64=0xcbf2_9ce4_8422_2325;for b in id.bytes(){h^=b as u64;h=h.wrapping_mul(0x0000_0100_0000_01b3);}format!("{:08x}",(h^(h>>32)) as u32)}
fn slug(title:&str)->String{let s:String=title.to_lowercase().chars().filter(|c|c.is_alphanumeric()||c.is_whitespace()||*c=='-').map(|c|if c.is_whitespace(){'-'}else{c}).take(60).collect();if s.is_empty(){"untitled".into()}else{s}}
pub fn final_rel(ms:i64,title:&str,id:&str)->String{let(y,mo,d,..)=local_parts(ms);let t=if title=="Untitled meeting"{""}else{title};format!("source/meetings/{y:04}/{mo:02}/{y:04}-{mo:02}-{d:02}-{}-{}.md",slug(t),disambiguator(id))}

#[derive(Debug,Clone,PartialEq,Serialize)]#[serde(rename_all="camelCase")]pub struct IndexMeta{pub meeting_id:String,pub platform:String,pub language:String}
#[derive(Debug,Clone,PartialEq,Serialize)]#[serde(rename_all="camelCase")]pub struct IndexUpsert{pub note_key:String,pub kind:&'static str,pub title:String,pub date:String,pub duration_sec:i64,pub participants:Vec<String>,pub body:String,pub content_hash:String,pub mtime_ms:i64,pub meta:IndexMeta}
#[derive(Debug,Clone,PartialEq,Serialize)]#[serde(rename_all="camelCase")]pub struct FinalizedNote{pub rel:String,pub hash:String,pub lines:usize,pub mtime_ms:i64,pub index:Option<IndexUpsert>}
fn candidate_rels(base:&str)->Vec<String>{let stem=base.strip_suffix(".md").expect("md");(1..=9).map(|n|if n==1{base.to_string()}else{format!("{stem}-{n}.md")}).collect()}
fn create_unique(root:&Path,base:&str,text:&str)->Result<notes_write::SavedNote,String>{for rel in candidate_rels(base){match notes_write::create_note(root,&notes_write::CreateReq{rel,text:text.to_string()}){Ok(s)=>return Ok(s),Err(e)if e.starts_with("exists")=>continue,Err(e)=>return Err(e)}}Err("exists: nine notes with this name already exist".into())}
fn verify(text:&str,id:&str,rows:usize)->Result<(),String>{if !text.starts_with("---\n")||!text.contains(&format!("\nid: {}\n",q(id))){return Err("verify_failed: frontmatter does not read back".into())}let body=text.split_once("\n## Transcript\n").map(|(_,b)|b).ok_or("verify_failed: no transcript heading")?;let n=body.lines().filter(|l|line_re().is_match(l)).count();if n!=rows{return Err(format!("verify_failed: {n} transcript lines read back, {rows} captured"))}Ok(())}
fn note_of(m:&FinalMeta,rows:&[Row],rel:String,opened:notes_write::OpenedNote)->FinalizedNote{let index=(opened.text.len()<=INDEX_BODY_BYTES).then(||IndexUpsert{note_key:rel.clone(),kind:"meeting",title:m.title.chars().take(500).collect(),date:crate::chat_archive::iso_utc(m.started_at_ms as f64/1000.0).replace('Z',".000Z"),duration_sec:(m.ended_at_ms-m.started_at_ms).max(0)/1000,participants:participants(rows).into_iter().take(200).map(|p|p.chars().take(200).collect()).collect(),body:opened.text.split_once("\n---\n").map(|(_,b)|b.to_string()).unwrap_or_default(),content_hash:opened.hash.clone(),mtime_ms:opened.mtime_ms,meta:IndexMeta{meeting_id:m.id.into(),platform:m.platform.into(),language:m.language.into()}});FinalizedNote{rel,hash:opened.hash,lines:rows.len(),mtime_ms:opened.mtime_ms,index}}
pub fn finalize(root:&Path,partial:Option<&Path>,m:&FinalMeta,rows:&[Row])->Result<FinalizedNote,String>{if rows.is_empty(){return Err("empty: nothing was captured".into())}let root=std::fs::canonicalize(root).map_err(io)?;let root=root.as_path();let text=render_meeting(m,rows);let saved=create_unique(root,&final_rel(m.started_at_ms,m.title,m.id),&text)?;let opened=notes_write::open_note(root,&saved.rel)?;verify(&opened.text,m.id,rows.len())?;if let Some(p)=partial{std::fs::remove_file(p).map_err(io)?;}Ok(note_of(m,rows,saved.rel,opened))}
/// The note an earlier archive run already wrote for exactly this capture (same name family, same bytes), so a crash
/// between the write and the ack never makes a second note. shortcut: an edited note, or one rendered in another time
/// zone, is not recognised and a new `-N` note is written; compare only the transcript section if that shows up.
pub fn find_archived(root:&Path,m:&FinalMeta,rows:&[Row])->Option<FinalizedNote>{if rows.is_empty(){return None}let root=std::fs::canonicalize(root).ok()?;let text=render_meeting(m,rows);for rel in candidate_rels(&final_rel(m.started_at_ms,m.title,m.id)){if let Ok(o)=notes_write::open_note(&root,&rel){if o.text==text{return Some(note_of(m,rows,rel,o))}}}None}
fn hms_secs(t:&str)->Option<i64>{let b=t.as_bytes();if b.len()!=8||!b.iter().enumerate().all(|(i,c)|if i==2||i==5{*c==b':'}else{c.is_ascii_digit()}){return None}let n=|i:usize|t[i..i+2].parse::<i64>().ok();let(h,mi,s)=(n(0)?,n(3)?,n(6)?);(h<24&&mi<60&&s<60).then_some(h*3600+mi*60+s)}
/// The core holds caption times as UTC `HH:MM:SS`; the Mac note format shows local time. The day comes from the capture
/// start, and it moves forward when the times wrap past midnight. A time that does not parse is left as it is (the
/// read-back verify then refuses the note, so it is never acked).
pub fn utc_times_to_local(started_at_ms:i64,rows:&mut [Row]){const DAY:i64=86_400_000;let mut day=started_at_ms.div_euclid(DAY)*DAY;let mut prev:Option<i64>=None;for r in rows.iter_mut(){let Some(secs)=hms_secs(&r.time)else{continue};let mut ms=day+secs*1000;match prev{None=>{if ms<started_at_ms-DAY/2{ms+=DAY;day+=DAY}else if ms>started_at_ms+DAY/2{ms-=DAY;day-=DAY}}Some(p)=>{if ms<p-DAY/2{ms+=DAY;day+=DAY}}}prev=Some(ms);r.time=local_hms(ms)}}
#[cfg(test)] mod tests{use super::*;use std::sync::atomic::{AtomicUsize,Ordering};
fn scratch(t:&str)->PathBuf{static N:AtomicUsize=AtomicUsize::new(0);let d=std::env::temp_dir().join(format!("llmide-cap-{t}-{}-{}",std::process::id(),N.fetch_add(1,Ordering::Relaxed)));let _=std::fs::remove_dir_all(&d);std::fs::create_dir_all(&d).unwrap();d}
fn row(t:&str,s:&str,x:&str)->Row{Row{time:t.into(),speaker:s.into(),text:x.into()}}
fn header(root:&Path)->PartialHeader{PartialHeader{v:1,id:"m-abc123-xyz789".into(),started_at_ms:1_762_335_000_000,language:"en".into(),notes_root:root.display().to_string()}}
#[test]fn ids(){let id=new_session_id(1_762_335_000_000);assert!(valid_session_id(&id));for b in["","m-","../x","m-ABC-1","m-abc-123/../../x","m-12345678901234-a"]{assert!(!valid_session_id(b),"{b}")}}
#[test]fn partial(){let dir=scratch("partial");let mut w=PartialWriter::create(&dir,&header(&dir)).unwrap();w.append_row(&row("09:30:01","Alice","Hello.")).unwrap();w.set_platform("zoom").unwrap();w.append_row(&row("09:30:04","Bob","Hi **there**.")).unwrap();w.sync().unwrap();let r=read_partial(w.path()).unwrap();assert_eq!(r.platform.as_deref(),Some("zoom"));assert_eq!(r.rows.len(),2);assert!(PartialWriter::create(&dir,&header(&dir)).is_err());assert_eq!(list_partials(&dir,None).len(),1);assert!(list_partials(&dir,Some("m-abc123-xyz789")).is_empty())}
#[cfg(unix)]#[test]fn mode(){use std::os::unix::fs::PermissionsExt;let dir=scratch("mode");let w=PartialWriter::create(&dir,&header(&dir)).unwrap();assert_eq!(std::fs::metadata(w.path()).unwrap().permissions().mode()&0o777,0o600)}
#[test]fn render(){let m=FinalMeta{id:"m-abc123-xyz789",title:"Weekly: sync \"Q4\"",started_at_ms:1_762_335_000_000,ended_at_ms:1_762_336_800_000,platform:"teams",language:"ja"};let t=render_meeting(&m,&[row("09:30:01","Bob","Hi."),row("09:30:04","Alice","Hello.")]);assert!(t.starts_with("---\nid: \"m-abc123-xyz789\"\ntitle: \"Weekly: sync \\\"Q4\\\"\"\nstarted_at: \"2025-11-05T09:30:00Z\"\n"));assert!(t.contains("\nduration_seconds: 1800\nparticipants: [\"Alice\",\"Bob\"]\nplatform: \"teams\"\nlanguage: \"ja\"\ntldr: []\n---\n\n## Transcript\n\n"));assert!(t.ends_with("[09:30:01] **Bob**: Hi.\n[09:30:04] **Alice**: Hello.\n"))}
#[test]fn names(){let rel=final_rel(1_762_335_000_000,"Weekly Sync / Q4!","m-abc123-xyz789");let re=Regex::new(r"^source/meetings/\d{4}/\d{2}/\d{4}-\d{2}-\d{2}-weekly-sync--q4-[0-9a-f]{8}\.md$").unwrap();assert!(re.is_match(&rel),"{rel}");assert!(final_rel(1_762_335_000_000,"","m-abc123-xyz789").contains("-untitled-"));assert_eq!(disambiguator("m-abc123-xyz789"),disambiguator("m-abc123-xyz789"))}
#[test]fn finalize_verify(){let root=scratch("root");let dir=scratch("data");let mut w=PartialWriter::create(&dir,&header(&root)).unwrap();w.append_row(&row("09:30:01","Alice","Hello.")).unwrap();let p=w.path().to_path_buf();drop(w);let m=FinalMeta{id:"m-abc123-xyz789",title:"Sync",started_at_ms:1_762_335_000_000,ended_at_ms:1_762_335_060_000,platform:"zoom",language:"en"};let rows=vec![row("09:30:01","Alice","Hello."),row("09:30:02","Bob","Hi.")];let n=finalize(&root,Some(&p),&m,&rows).unwrap();assert_eq!(n.lines,2);assert!(!p.exists());let disk=std::fs::read_to_string(root.join(&n.rel)).unwrap();assert!(disk.contains("[09:30:02] **Bob**: Hi.\n"));let idx=n.index.unwrap();assert_eq!(idx.note_key,n.rel);assert!(idx.body.starts_with("\n## Transcript"));let n2=finalize(&root,None,&m,&rows).unwrap();assert_ne!(n2.rel,n.rel);assert!(n2.rel.ends_with("-2.md"))}
#[test]fn finalize_empty(){let root=scratch("empty");let m=FinalMeta{id:"m-abc123-xyz789",title:"",started_at_ms:0,ended_at_ms:0,platform:"zoom",language:"en"};assert!(finalize(&root,None,&m,&[]).unwrap_err().starts_with("empty"))}
fn ext_meta()->FinalMeta<'static>{FinalMeta{id:"0b6c2d4e-1111-4a2b-9c3d-123456789abc",title:"Sync",started_at_ms:1_762_335_000_000,ended_at_ms:1_762_335_060_000,platform:"chrome-extension",language:"en"}}
#[test]fn archived_note_is_found_again(){let root=scratch("again");let m=ext_meta();let rows=vec![row("09:30:01","Alice","Hello.")];assert!(find_archived(&root,&m,&rows).is_none());let n=finalize(&root,None,&m,&rows).unwrap();let again=find_archived(&root,&m,&rows).unwrap();assert_eq!(again.rel,n.rel);assert_eq!(again.hash,n.hash);assert_eq!(again.lines,1);assert_eq!(again.index.unwrap().note_key,n.rel);let more=vec![row("09:30:01","Alice","Hello."),row("09:30:02","Bob","Hi.")];assert!(find_archived(&root,&m,&more).is_none(),"other content is another note")}
#[test]fn edited_note_is_not_reused(){let root=scratch("edited");let m=ext_meta();let rows=vec![row("09:30:01","Alice","Hello.")];let n=finalize(&root,None,&m,&rows).unwrap();std::fs::write(root.join(&n.rel),"changed").unwrap();assert!(find_archived(&root,&m,&rows).is_none())}
#[test]fn utc_times_become_local(){const DAY:i64=86_400_000;let start=1_762_335_000_000;let mut r=vec![row("09:30:01","A","x")];utc_times_to_local(start,&mut r);assert_eq!(r[0].time,local_hms(start+1_000));
let late=(start/DAY)*DAY+86_390_000;let mut r=vec![row("23:59:55","A","x"),row("00:00:05","B","y")];utc_times_to_local(late,&mut r);assert_eq!(r[0].time,local_hms(late+5_000));assert_eq!(r[1].time,local_hms(late+15_000),"past UTC midnight");
let early=(start/DAY)*DAY+DAY+5_000;let mut r=vec![row("23:59:40","A","x")];utc_times_to_local(early,&mut r);assert_eq!(r[0].time,local_hms(early-25_000),"a caption just before the start, across midnight");
let mut r=vec![row("9:30","A","x")];utc_times_to_local(start,&mut r);assert_eq!(r[0].time,"9:30","an unreadable time is left for verify to refuse")}
}
