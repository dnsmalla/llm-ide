//! Bounded macOS Accessibility read for one meeting app. Only role/title/description/value/windows are copied.
use crate::capture_model::{AxAppTree, AxNode, AxReadError};
use std::time::Instant;

/// Node and time allowance of one tree read. Running out is not an error but the tree is then partial, and a partial
/// tree must never be reported as a snapshot: the delta would close every row it is missing and the next full read
/// would append them again.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) struct Budget { left: usize, deadline: Instant, truncated: bool }
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
impl Budget {
    pub(crate) fn new(max_nodes: usize, deadline: Instant) -> Self { Self { left: max_nodes, deadline, truncated: false } }
    /// Spends one node; false (and the read is marked truncated) when nodes or time ran out.
    pub(crate) fn take(&mut self, now: Instant) -> bool {
        if self.left == 0 || now >= self.deadline { self.truncated = true; return false; }
        self.left -= 1; true
    }
    /// The read result: a truncated walk is "no snapshot this tick", never a smaller tree.
    pub(crate) fn finish(&self, tree: AxAppTree) -> Result<Option<AxAppTree>, AxReadError> {
        if self.truncated { Err(AxReadError::Truncated) } else { Ok(Some(tree)) }
    }
}

#[cfg(target_os = "macos")] pub const SUPPORTED: bool = true;
#[cfg(not(target_os = "macos"))] pub const SUPPORTED: bool = false;
#[cfg(target_os = "macos")] pub use macos::{is_trusted, prompt_trust, read_app_tree, running_pid};
#[cfg(not(target_os = "macos"))] pub fn is_trusted()->bool{false}
#[cfg(not(target_os = "macos"))] pub fn prompt_trust()->bool{false}
#[cfg(not(target_os = "macos"))] pub fn running_pid(_b:&str)->Option<i32>{None}
#[cfg(not(target_os = "macos"))] pub fn read_app_tree(_b:&str)->Result<Option<AxAppTree>,AxReadError>{Err(AxReadError::Unsupported)}

#[cfg(target_os = "macos")]
mod macos {
    use super::{AxAppTree, AxNode, AxReadError, Budget};
    use std::ffi::{c_char, c_void, CString};
    use std::time::{Duration, Instant};
    type CfRef=*const c_void; type AxError=i32;
    const AX_OK:AxError=0; const DISABLED:AxError=-25211; const CANNOT:AxError=-25204; const UTF8:u32=0x0800_0100;
    const TIMEOUT:f32=0.3; const MAX_DEPTH:u32=16; const MAX_NODES:usize=2000; const DEADLINE:Duration=Duration::from_millis(500); const MAX_UNITS:isize=20_000;
    #[repr(C)] struct KeyCB([usize;6]); #[repr(C)] struct ValCB([usize;5]);
    #[link(name="ApplicationServices",kind="framework")] extern "C" {
        fn AXIsProcessTrusted()->u8; fn AXIsProcessTrustedWithOptions(o:CfRef)->u8; static kAXTrustedCheckOptionPrompt:CfRef;
        fn AXUIElementCreateApplication(pid:i32)->CfRef; fn AXUIElementSetMessagingTimeout(e:CfRef,t:f32)->AxError;
        fn AXUIElementCopyAttributeValue(e:CfRef,a:CfRef,v:*mut CfRef)->AxError;
    }
    #[link(name="CoreFoundation",kind="framework")] extern "C" {
        static kCFBooleanTrue:CfRef; static kCFTypeDictionaryKeyCallBacks:KeyCB; static kCFTypeDictionaryValueCallBacks:ValCB;
        fn CFDictionaryCreate(a:CfRef,k:*const CfRef,v:*const CfRef,n:isize,kcb:*const KeyCB,vcb:*const ValCB)->CfRef;
        fn CFRelease(c:CfRef); fn CFGetTypeID(c:CfRef)->usize; fn CFArrayGetTypeID()->usize; fn CFStringGetTypeID()->usize;
        fn CFArrayGetCount(a:CfRef)->isize; fn CFArrayGetValueAtIndex(a:CfRef,i:isize)->CfRef;
        fn CFStringCreateWithCString(a:CfRef,s:*const c_char,e:u32)->CfRef; fn CFStringGetLength(s:CfRef)->isize;
        fn CFStringGetMaximumSizeForEncoding(l:isize,e:u32)->isize; fn CFStringGetCString(s:CfRef,b:*mut c_char,n:isize,e:u32)->u8;
    }
    pub struct Owned(pub CfRef);
    impl Drop for Owned { fn drop(&mut self){ if !self.0.is_null(){unsafe{CFRelease(self.0)}} } }
    pub fn cf_string(s:&str)->Option<Owned>{let c=CString::new(s).ok()?;let r=unsafe{CFStringCreateWithCString(std::ptr::null(),c.as_ptr(),UTF8)};(!r.is_null()).then(||Owned(r))}
    pub fn string_of(cf:CfRef)->Option<String>{if cf.is_null()||unsafe{CFGetTypeID(cf)!=CFStringGetTypeID()}{return None}let len=unsafe{CFStringGetLength(cf)};if len>MAX_UNITS{return None}let size=unsafe{CFStringGetMaximumSizeForEncoding(len,UTF8)}+1;let mut b=vec![0u8;size.max(1) as usize];let ok=unsafe{CFStringGetCString(cf,b.as_mut_ptr() as *mut c_char,size,UTF8)}!=0;if !ok{return None}let end=b.iter().position(|x|*x==0).unwrap_or(b.len());Some(String::from_utf8_lossy(&b[..end]).into_owned())}
    pub fn is_trusted()->bool{unsafe{AXIsProcessTrusted()!=0}}
    pub fn prompt_trust()->bool{unsafe{let keys=[kAXTrustedCheckOptionPrompt];let vals=[kCFBooleanTrue];let d=Owned(CFDictionaryCreate(std::ptr::null(),keys.as_ptr(),vals.as_ptr(),1,&kCFTypeDictionaryKeyCallBacks,&kCFTypeDictionaryValueCallBacks));AXIsProcessTrustedWithOptions(d.0)!=0}}
    pub fn running_pid(b:&str)->Option<i32>{use objc2_app_kit::NSRunningApplication;use objc2_foundation::NSString;let apps=NSRunningApplication::runningApplicationsWithBundleIdentifier(&NSString::from_str(b));apps.iter().map(|a|a.processIdentifier()).find(|p|*p>0)}
    struct Names{role:Owned,title:Owned,description:Owned,value:Owned,children:Owned,windows:Owned}
    fn names()->Option<Names>{Some(Names{role:cf_string("AXRole")?,title:cf_string("AXTitle")?,description:cf_string("AXDescription")?,value:cf_string("AXValue")?,children:cf_string("AXChildren")?,windows:cf_string("AXWindows")?})}
    fn copy(el:CfRef,a:&Owned)->Result<Option<Owned>,AxError>{let mut out=std::ptr::null();let e=unsafe{AXUIElementCopyAttributeValue(el,a.0,&mut out)};if e!=AX_OK{return Err(e)}Ok((!out.is_null()).then(||Owned(out)))}
    fn map(e:AxError)->Option<AxReadError>{match e{DISABLED=>Some(AxReadError::PermissionDenied),CANNOT=>Some(AxReadError::CannotComplete),_=>None}}
    fn str_attr(el:CfRef,a:&Owned)->Result<Option<String>,AxReadError>{match copy(el,a){Ok(Some(v))=>Ok(string_of(v.0)),Ok(None)=>Ok(None),Err(e)=>map(e).map_or(Ok(None),Err)}}
    fn array(el:CfRef,a:&Owned)->Result<Option<(Owned,isize)>,AxReadError>{match copy(el,a){Ok(Some(x))=>{if unsafe{CFGetTypeID(x.0)!=CFArrayGetTypeID()}{return Ok(None)}let n=unsafe{CFArrayGetCount(x.0)};Ok(Some((x,n)))}Ok(None)=>Ok(None),Err(e)=>map(e).map_or(Ok(None),Err)}}
    fn node(el:CfRef,d:u32,n:&Names,b:&mut Budget)->Result<Option<AxNode>,AxReadError>{if !b.take(Instant::now()){return Ok(None)}let _=unsafe{AXUIElementSetMessagingTimeout(el,TIMEOUT)};let role=str_attr(el,&n.role)?.unwrap_or_default();let mut out=AxNode{role,..Default::default()};match out.role.as_str(){"AXWindow"=>out.title=str_attr(el,&n.title)?,"AXGroup"=>out.description=str_attr(el,&n.description)?,"AXStaticText"=>out.value=str_attr(el,&n.value)?,_=>{}};if d<MAX_DEPTH{if let Some((a,c))=array(el,&n.children)?{for i in 0..c{let ch=unsafe{CFArrayGetValueAtIndex(a.0,i)};if ch.is_null(){continue}match node(ch,d+1,n,b)?{Some(x)=>out.children.push(x),None=>break}}}}Ok(Some(out))}
    pub fn read_app_tree(b:&str)->Result<Option<AxAppTree>,AxReadError>{let Some(pid)=running_pid(b)else{return Ok(None)};if !is_trusted(){return Err(AxReadError::PermissionDenied)}let n=names().ok_or(AxReadError::Unsupported)?;let app=Owned(unsafe{AXUIElementCreateApplication(pid)});if app.0.is_null(){return Ok(None)}let _=unsafe{AXUIElementSetMessagingTimeout(app.0,TIMEOUT)};let mut budget=Budget::new(MAX_NODES,Instant::now()+DEADLINE);let mut windows=Vec::new();if let Some((a,c))=array(app.0,&n.windows)?{for i in 0..c{let w=unsafe{CFArrayGetValueAtIndex(a.0,i)};if w.is_null(){continue}match node(w,0,&n,&mut budget)?{Some(x)=>windows.push(x),None=>break}}}budget.finish(AxAppTree{bundle_id:b.to_string(),windows})}
    #[cfg(test)] mod tests{use super::*; #[test]fn unknown_app(){assert_eq!(running_pid("com.llmide.no-such-app"),None);assert!(matches!(read_app_tree("com.llmide.no-such-app"),Ok(None)|Err(AxReadError::PermissionDenied)))} #[test]fn trust_no_prompt(){let _=is_trusted();} #[test]fn cf_roundtrip(){let s=cf_string("AXStaticText 字幕").unwrap();assert_eq!(string_of(s.0).as_deref(),Some("AXStaticText 字幕"))}}
}

/// Spike-only: one app's tree as pretty JSON under `<desktop data dir>/capture-fixtures/`.
#[cfg(feature = "spike")]
#[tauri::command]
pub async fn capture_dump_tree(bundle_id: String) -> Result<String, String> {
    if !matches!(bundle_id.as_str(), "us.zoom.xos" | "com.microsoft.teams2") { return Err("invalid_app: only the meeting apps the readers know".into()); }
    tauri::async_runtime::spawn_blocking(move || {
        let tree = read_app_tree(&bundle_id).map_err(|e| format!("ax: {e:?}"))?.ok_or("not_running")?;
        let dir = crate::fsutil::desktop_data_dir()?.join("capture-fixtures");
        std::fs::create_dir_all(&dir).map_err(|e| format!("io: {e}"))?;
        let ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
        let path = dir.join(format!("{bundle_id}-{ms}.json"));
        std::fs::write(&path, serde_json::to_vec_pretty(&tree).map_err(|e| format!("io: {e}"))?).map_err(|e| format!("io: {e}"))?;
        Ok(path.display().to_string())
    }).await.map_err(|e| format!("io: {e}"))?
}

#[cfg(test)]
mod budget_tests {
    use super::*;
    use std::time::Duration;
    fn tree() -> AxAppTree { AxAppTree { bundle_id: "x".into(), windows: Vec::new() } }
    #[test] fn within_budget_is_a_snapshot() {
        let now = Instant::now();
        let mut b = Budget::new(2, now + Duration::from_secs(1));
        assert!(b.take(now) && b.take(now));
        assert!(matches!(b.finish(tree()), Ok(Some(_))));
    }
    #[test] fn node_limit_is_no_snapshot() {
        let now = Instant::now();
        let mut b = Budget::new(1, now + Duration::from_secs(1));
        assert!(b.take(now) && !b.take(now));
        assert_eq!(b.finish(tree()).unwrap_err(), AxReadError::Truncated);
    }
    #[test] fn deadline_is_no_snapshot() {
        let now = Instant::now();
        let mut b = Budget::new(100, now + Duration::from_millis(500));
        assert!(!b.take(now + Duration::from_millis(500)));
        assert_eq!(b.finish(tree()).unwrap_err(), AxReadError::Truncated);
    }
}
