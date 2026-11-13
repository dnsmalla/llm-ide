//! Snapshot -> row deltas for AX-read captions, a port of the Mac's CaptionDeltaState.
use std::collections::HashSet;
use serde::Serialize;
use crate::capture_validate::Line;
pub const MAX_EMPTY_TICKS: u32 = 13;
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CaptionDelta { Append { row: u64, speaker: String, text: String }, Replace { row: u64, speaker: String, old_text: String, new_text: String }, Closed { row: u64 } }
#[derive(Debug, Clone)] struct Entry { row: u64, speaker: String, text: String }
/// Rows remembered after the captions panel vanished, so a returning panel does not append its history again.
const MAX_VANISHED: usize = 500;
/// Revision rule (see `is_revision`): shorter texts must match exactly after normalising.
const REVISION_MIN_CHARS: usize = 12;
/// Revision rule: at most this share of the longer text may differ (Levenshtein, normalised characters).
const REVISION_MAX_EDIT_PERCENT: usize = 25;
#[derive(Debug, Default)] pub struct DeltaState { previous: Vec<Entry>, vanished: Vec<Entry>, next_row: u64, empty_streak: u32 }

enum Resolution { Kept(usize), Revived(Entry), Updated(usize), New }

impl DeltaState {
    pub fn new() -> Self { Self::default() }
    /// Turns one snapshot into row deltas. A snapshot row is resolved, in order, as: an exact match of the previous
    /// snapshot; an exact match of a row closed when the panel vanished (first snapshot after it returns only); a growth
    /// of one previous row (new text extends the old one); a revision of the single unmatched same-speaker previous row
    /// (`is_revision`); otherwise a new row. Previous rows nothing resolved to are closed.
    pub fn ingest(&mut self, snapshot: &[Line]) -> Vec<CaptionDelta> {
        if snapshot.is_empty() {
            self.empty_streak += 1;
            if self.empty_streak <= MAX_EMPTY_TICKS || self.previous.is_empty() { return Vec::new(); }
            let closed = self.previous.iter().map(|e| CaptionDelta::Closed { row: e.row }).collect();
            // Why: a panel that comes back with its history must not re-append rows that are already closed.
            let skip = self.previous.len().saturating_sub(MAX_VANISHED);
            self.vanished = self.previous.drain(..).skip(skip).collect();
            return closed;
        }
        self.empty_streak = 0;
        // Only the first snapshot after the panel returns may revive; later repeats are genuinely new rows.
        let mut vanished = std::mem::take(&mut self.vanished);
        let pk: Vec<(&str,&str)> = self.previous.iter().map(|e|(e.speaker.as_str(),e.text.as_str())).collect();
        let ck: Vec<(&str,&str)> = snapshot.iter().map(|(s,t)|(s.as_str(),t.as_str())).collect();
        let aligned = align(&pk,&ck);
        let matched: HashSet<usize> = aligned.iter().flatten().copied().collect();
        let on: HashSet<(&str,&str)> = ck.iter().copied().collect();
        let cand: Vec<usize> = (0..pk.len()).filter(|i| !matched.contains(i) && !on.contains(&pk[*i])).collect();
        let mut claimed: HashSet<usize> = HashSet::new();
        let mut res: Vec<Option<Resolution>> = (0..snapshot.len()).map(|j| aligned[j].map(Resolution::Kept)).collect();
        for (j,(sp,tx)) in snapshot.iter().enumerate() {
            if res[j].is_some() { continue; }
            if let Some(pos) = vanished.iter().position(|e| e.speaker==*sp && e.text==*tx) { res[j] = Some(Resolution::Revived(vanished.remove(pos))); }
        }
        for (j,(sp,tx)) in snapshot.iter().enumerate() {
            if res[j].is_some() { continue; }
            let src=cand.iter().copied().filter(|i|!claimed.contains(i)).filter(|i|self.previous[*i].speaker==*sp && is_growth(&self.previous[*i].text,tx)).min_by_key(|i|i.abs_diff(j));
            if let Some(i)=src { claimed.insert(i); res[j] = Some(Resolution::Updated(i)); }
        }
        let speakers: Vec<&str> = { let mut v: Vec<&str> = snapshot.iter().enumerate().filter(|(j,_)|res[*j].is_none()).map(|(_,(s,_))|s.as_str()).collect(); v.sort_unstable(); v.dedup(); v };
        for sp in speakers {
            let js: Vec<usize> = (0..snapshot.len()).filter(|j| res[*j].is_none() && snapshot[*j].0==sp).collect();
            let is: Vec<usize> = cand.iter().copied().filter(|i| !claimed.contains(i) && self.previous[*i].speaker==sp).collect();
            // Why: with more than one candidate on either side the pairing is a guess, and a wrong merge loses a sentence.
            if let ([j],[i]) = (js.as_slice(), is.as_slice()) {
                if is_revision(&self.previous[*i].text, &snapshot[*j].1) { claimed.insert(*i); res[*j] = Some(Resolution::Updated(*i)); }
            }
        }
        let mut out=Vec::new(); let mut cur=Vec::with_capacity(snapshot.len());
        for (j,(sp,tx)) in snapshot.iter().enumerate() {
            match res[j].take().unwrap_or(Resolution::New) {
                Resolution::Kept(i) => cur.push(self.previous[i].clone()),
                Resolution::Revived(e) => cur.push(e),
                Resolution::Updated(i) => { let old=&self.previous[i]; out.push(CaptionDelta::Replace{row:old.row,speaker:sp.clone(),old_text:old.text.clone(),new_text:tx.clone()}); cur.push(Entry{row:old.row,speaker:sp.clone(),text:tx.clone()}); }
                Resolution::New => { let row=self.next_row; self.next_row+=1; out.push(CaptionDelta::Append{row,speaker:sp.clone(),text:tx.clone()}); cur.push(Entry{row,speaker:sp.clone(),text:tx.clone()}); }
            }
        }
        for (i,old) in self.previous.iter().enumerate() { if !matched.contains(&i)&&!claimed.contains(&i) { out.push(CaptionDelta::Closed{row:old.row}); } }
        self.previous=cur; out
    }
}
fn is_growth(old:&str,new:&str)->bool { if old.is_empty()||new.len()<=old.len()||!new.starts_with(old){return false} match (old.chars().next_back(),new[old.len()..].chars().next()){ (Some(a),Some(b))=>!(a.is_ascii_alphanumeric()&&b.is_ascii_alphanumeric()), _=>false } }
fn normalized(s:&str)->Vec<char> { s.chars().filter(|c|c.is_alphanumeric()).flat_map(|c|c.to_lowercase()).collect() }
fn edit_distance(a:&[char],b:&[char])->usize {
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    for (i,ca) in a.iter().enumerate() {
        let mut cur = vec![i+1; b.len()+1];
        for (j,cb) in b.iter().enumerate() { cur[j+1] = (prev[j] + usize::from(ca!=cb)).min(prev[j+1]+1).min(cur[j]+1); }
        prev = cur;
    }
    prev[b.len()]
}
/// Whether `new` is the live-caption engine revising `old` (same utterance) rather than a different sentence. Rule:
/// after lowercasing and dropping everything but letters and digits, the two texts are equal (capitalisation and
/// punctuation edits), or both have at least REVISION_MIN_CHARS characters and differ by at most
/// REVISION_MAX_EDIT_PERCENT of the longer one (Levenshtein; word swaps inside a long sentence). Anything else is a
/// different sentence: a wrong merge loses text, a missed one only duplicates it.
fn is_revision(old:&str,new:&str)->bool {
    let (a,b)=(normalized(old),normalized(new));
    if a.is_empty()||b.is_empty() { return false }
    if a==b { return true }
    let longest=a.len().max(b.len());
    if a.len().min(b.len())<REVISION_MIN_CHARS || a.len().abs_diff(b.len())*100>longest*REVISION_MAX_EDIT_PERCENT { return false }
    edit_distance(&a,&b)*100<=longest*REVISION_MAX_EDIT_PERCENT
}
pub fn align(prev:&[(&str,&str)],cur:&[(&str,&str)])->Vec<Option<usize>> {
    let mut result=vec![None;cur.len()]; if prev.is_empty()||cur.is_empty(){return result}
    let ps:HashSet<(&str,&str)>=prev.iter().copied().collect(); let cs:HashSet<(&str,&str)>=cur.iter().copied().collect();
    let p:Vec<usize>=(0..prev.len()).filter(|i|cs.contains(&prev[*i])).collect(); let c:Vec<usize>=(0..cur.len()).filter(|j|ps.contains(&cur[*j])).collect();
    let lim=p.len().min(c.len()); let mut head=0; while head<lim&&prev[p[head]]==cur[c[head]]{result[c[head]]=Some(p[head]);head+=1}
    let mut tail=0; while tail<lim-head&&prev[p[p.len()-1-tail]]==cur[c[c.len()-1-tail]]{result[c[c.len()-1-tail]]=Some(p[p.len()-1-tail]);tail+=1}
    let rows=p.len()-head-tail; let cols=c.len()-head-tail; if rows==0||cols==0{return result}
    let eq=|i:usize,j:usize|prev[p[head+i]]==cur[c[head+j]]; let w=cols+1; let mut t=vec![0u32;(rows+1)*w];
    for i in (0..rows).rev(){for j in (0..cols).rev(){t[i*w+j]=if eq(i,j){t[(i+1)*w+j+1]+1}else{t[(i+1)*w+j].max(t[i*w+j+1])}}}
    let(mut i,mut j)=(0,0); while i<rows&&j<cols{if eq(i,j){result[c[head+j]]=Some(p[head+i]);i+=1;j+=1}else if t[(i+1)*w+j]>=t[i*w+j+1]{i+=1}else{j+=1}} result
}
#[cfg(test)] mod tests { use super::*; fn l(xs:&[(&str,&str)])->Vec<Line>{xs.iter().map(|(s,t)|(s.to_string(),t.to_string())).collect()}
 #[test] fn unchanged(){let mut s=DeltaState::new();assert_eq!(s.ingest(&l(&[("A","Hello")])),vec![CaptionDelta::Append{row:0,speaker:"A".into(),text:"Hello".into()}]);assert!(s.ingest(&l(&[("A","Hello")])).is_empty());}
 #[test] fn growth(){let mut s=DeltaState::new();s.ingest(&l(&[("A","Hello")]));assert_eq!(s.ingest(&l(&[("A","Hello there")])),vec![CaptionDelta::Replace{row:0,speaker:"A".into(),old_text:"Hello".into(),new_text:"Hello there".into()}]);}
 #[test] fn repeated(){let mut s=DeltaState::new();s.ingest(&l(&[("A","Yes.")]));s.ingest(&l(&[("A","Yes."),("B","Agreed?")]));assert_eq!(s.ingest(&l(&[("A","Yes."),("B","Agreed?"),("A","Yes.")])),vec![CaptionDelta::Append{row:2,speaker:"A".into(),text:"Yes.".into()}]);}
 #[test] fn empty(){let mut s=DeltaState::new();s.ingest(&l(&[("A","Hello")]));assert!(s.ingest(&[]).is_empty());let mut last=vec![];for _ in 0..MAX_EMPTY_TICKS{last=s.ingest(&[])}assert_eq!(last,vec![CaptionDelta::Closed{row:0}]);}
 #[test] fn align_order(){let p=[("A","1"),("B","2")];let c=[("A","1"),("B","2")];assert_eq!(align(&p,&c),vec![Some(0),Some(1)]);}

 #[test] fn revision_of_case_and_punctuation(){let mut s=DeltaState::new();s.ingest(&l(&[("A","hello there")]));assert_eq!(s.ingest(&l(&[("A","Hello there.")])),vec![CaptionDelta::Replace{row:0,speaker:"A".into(),old_text:"hello there".into(),new_text:"Hello there.".into()}]);}
 #[test] fn revision_of_a_word_in_a_long_sentence(){let mut s=DeltaState::new();s.ingest(&l(&[("A","we should go to the market")]));let d=s.ingest(&l(&[("A","we shall go to the market")]));assert!(matches!(d.as_slice(),[CaptionDelta::Replace{row:0,..}]),"{d:?}");}
 #[test] fn different_sentence_is_not_merged(){let mut s=DeltaState::new();s.ingest(&l(&[("A","Let us start the meeting now")]));let d=s.ingest(&l(&[("A","The budget is over by ten percent")]));assert_eq!(d,vec![CaptionDelta::Append{row:1,speaker:"A".into(),text:"The budget is over by ten percent".into()},CaptionDelta::Closed{row:0}]);}
 #[test] fn revision_threshold(){let base="abcdefghijkl";assert!(is_revision(base,"abcdefghixyz"),"3 of 12 = 25 percent");assert!(!is_revision(base,"abcdefghwxyz"),"4 of 12 is over");assert!(!is_revision("short one","short two"),"under 12 chars only case/punctuation edits count");assert!(is_revision("Yes.","yes"));}
 #[test] fn ambiguous_revision_is_not_merged(){let mut s=DeltaState::new();s.ingest(&l(&[("A","hello there my friend"),("A","what a lovely day today")]));let d=s.ingest(&l(&[("A","Hello there my friend.")]));assert!(!d.iter().any(|x|matches!(x,CaptionDelta::Replace{..})),"two previous same-speaker rows: no guess: {d:?}");}
 #[test] fn other_speaker_is_not_merged(){let mut s=DeltaState::new();s.ingest(&l(&[("A","hello there")]));let d=s.ingest(&l(&[("B","Hello there.")]));assert!(d.contains(&CaptionDelta::Closed{row:0}));}
 #[test] fn returning_panel_does_not_duplicate_history(){let mut s=DeltaState::new();let hist=l(&[("A","Hello."),("B","Hi there.")]);s.ingest(&hist);for _ in 0..MAX_EMPTY_TICKS{s.ingest(&[]);}let d=s.ingest(&l(&[("A","Hello."),("B","Hi there."),("A","New line.")]));assert_eq!(d,vec![CaptionDelta::Append{row:2,speaker:"A".into(),text:"New line.".into()}]);let g=s.ingest(&l(&[("A","Hello."),("B","Hi there. How are you"),("A","New line.")]));assert_eq!(g,vec![CaptionDelta::Replace{row:1,speaker:"B".into(),old_text:"Hi there.".into(),new_text:"Hi there. How are you".into()}]);}
 #[test] fn vanished_rows_revive_once(){let mut s=DeltaState::new();s.ingest(&l(&[("A","Yes.")]));for _ in 0..MAX_EMPTY_TICKS{s.ingest(&[]);}assert!(s.ingest(&l(&[("A","Yes.")])).is_empty());let d=s.ingest(&l(&[("A","Yes."),("A","Yes.")]));assert_eq!(d,vec![CaptionDelta::Append{row:1,speaker:"A".into(),text:"Yes.".into()}],"a later repeat is a new row");}
}
