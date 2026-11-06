//! Snapshot -> row deltas for AX-read captions, a port of the Mac's CaptionDeltaState.
use std::collections::HashSet;
use serde::Serialize;
use crate::capture_validate::Line;
pub const MAX_EMPTY_TICKS: u32 = 13;
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CaptionDelta { Append { row: u64, speaker: String, text: String }, Replace { row: u64, speaker: String, old_text: String, new_text: String }, Closed { row: u64 } }
#[derive(Debug, Clone)] struct Entry { row: u64, speaker: String, text: String }
#[derive(Debug, Default)] pub struct DeltaState { previous: Vec<Entry>, next_row: u64, empty_streak: u32 }

impl DeltaState {
    pub fn new() -> Self { Self::default() }
    pub fn ingest(&mut self, snapshot: &[Line]) -> Vec<CaptionDelta> {
        if snapshot.is_empty() {
            self.empty_streak += 1;
            if self.empty_streak <= MAX_EMPTY_TICKS || self.previous.is_empty() { return Vec::new(); }
            let closed = self.previous.iter().map(|e| CaptionDelta::Closed { row: e.row }).collect();
            self.previous.clear(); return closed;
        }
        self.empty_streak = 0;
        let pk: Vec<(&str,&str)> = self.previous.iter().map(|e|(e.speaker.as_str(),e.text.as_str())).collect();
        let ck: Vec<(&str,&str)> = snapshot.iter().map(|(s,t)|(s.as_str(),t.as_str())).collect();
        let aligned = align(&pk,&ck);
        let matched: HashSet<usize> = aligned.iter().flatten().copied().collect();
        let on: HashSet<(&str,&str)> = ck.iter().copied().collect();
        let cand: Vec<usize> = (0..pk.len()).filter(|i| !matched.contains(i) && !on.contains(&pk[*i])).collect();
        let mut claimed=HashSet::new(); let mut out=Vec::new(); let mut cur=Vec::with_capacity(snapshot.len());
        for (j,(sp,tx)) in snapshot.iter().enumerate() {
            if let Some(i)=aligned[j] { cur.push(self.previous[i].clone()); continue; }
            let src=cand.iter().copied().filter(|i|!claimed.contains(i)).filter(|i|self.previous[*i].speaker==*sp && is_growth(&self.previous[*i].text,tx)).min_by_key(|i|i.abs_diff(j));
            if let Some(i)=src { claimed.insert(i); let old=&self.previous[i]; out.push(CaptionDelta::Replace{row:old.row,speaker:sp.clone(),old_text:old.text.clone(),new_text:tx.clone()}); cur.push(Entry{row:old.row,speaker:sp.clone(),text:tx.clone()}); }
            else { let row=self.next_row; self.next_row+=1; out.push(CaptionDelta::Append{row,speaker:sp.clone(),text:tx.clone()}); cur.push(Entry{row,speaker:sp.clone(),text:tx.clone()}); }
        }
        for (i,old) in self.previous.iter().enumerate() { if !matched.contains(&i)&&!claimed.contains(&i) { out.push(CaptionDelta::Closed{row:old.row}); } }
        self.previous=cur; out
    }
}
fn is_growth(old:&str,new:&str)->bool { if old.is_empty()||new.len()<=old.len()||!new.starts_with(old){return false} match (old.chars().next_back(),new[old.len()..].chars().next()){ (Some(a),Some(b))=>!(a.is_ascii_alphanumeric()&&b.is_ascii_alphanumeric()), _=>false } }
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
}
