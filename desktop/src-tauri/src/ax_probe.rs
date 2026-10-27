//! macOS accessibility probe (Phase 0 T8).
//!
//! Checks `AXIsProcessTrusted()` without prompting. Untrusted: one `ax` status line
//! (`permission_denied`) and nothing else. Trusted: for 10 s, every 800 ms, reads the focused
//! window's accessibility tree (depth <= 12, <= 2 000 elements) and times the read. Only counts
//! and timings leave this module: the attribute values are copied, timed and released, never
//! stored or printed.
//!
//! Uses a small FFI to ApplicationServices and CoreFoundation (no extra crate). Non-macOS builds
//! get a stub that reports `unsupported`.

use serde::Serialize;

/// Result returned to the webview and printed as BENCH lines.
#[derive(Serialize, Clone, Debug)]
pub struct AxProbeResult {
    pub status: &'static str,
    pub samples: u32,
    pub ax_read_ms_p50: f64,
    pub ax_read_ms_max: f64,
    pub ax_elements: u64,
}

const PROBE_WINDOW_MS: u64 = 10_000;
const SAMPLE_INTERVAL_MS: u64 = 800;
const MAX_DEPTH: u32 = 12;
const MAX_ELEMENTS: u64 = 2_000;

fn empty(status: &'static str) -> AxProbeResult {
    AxProbeResult { status, samples: 0, ax_read_ms_p50: 0.0, ax_read_ms_max: 0.0, ax_elements: 0 }
}

/// Prints the BENCH lines for a result. `ax` carries the status; an `ok` run adds timings.
fn print_bench(result: &AxProbeResult) {
    let status_line = serde_json::json!({
        "name": "ax",
        "value": if result.status == "ok" { 1 } else { 0 },
        "unit": "status",
        "status": result.status,
    });
    println!("BENCH {status_line}");
    if result.status != "ok" {
        return;
    }
    let lines = [
        serde_json::json!({ "name": "ax_read_ms_p50", "value": result.ax_read_ms_p50, "unit": "ms", "samples": result.samples }),
        serde_json::json!({ "name": "ax_read_ms_max", "value": result.ax_read_ms_max, "unit": "ms", "samples": result.samples }),
        serde_json::json!({ "name": "ax_elements", "value": result.ax_elements, "unit": "count" }),
    ];
    for line in lines {
        println!("BENCH {line}");
    }
}

/// Nearest-rank percentile over a sorted, non-empty slice.
fn percentile(sorted: &[f64], p: f64) -> f64 {
    let idx = ((p * sorted.len() as f64).ceil() as usize).clamp(1, sorted.len()) - 1;
    sorted[idx]
}

fn round1(n: f64) -> f64 {
    (n * 10.0).round() / 10.0
}

/// Runs the probe on the calling thread and prints its BENCH lines.
#[cfg(target_os = "macos")]
pub fn run_probe() -> AxProbeResult {
    let result = macos::probe();
    print_bench(&result);
    result
}

/// Non-macOS stub: the probe does not exist there.
#[cfg(not(target_os = "macos"))]
pub fn run_probe() -> AxProbeResult {
    let result = empty("unsupported");
    print_bench(&result);
    result
}

/// Tauri command: runs the probe off the main thread (it takes about 10 s).
#[tauri::command]
pub async fn ax_probe() -> Result<AxProbeResult, String> {
    tauri::async_runtime::spawn_blocking(run_probe)
        .await
        .map_err(|e| format!("ax probe task failed: {e}"))
}

/// Summarises the per-sample read times into the probe result.
fn summarise(mut times_ms: Vec<f64>, elements: u64, saw_window: bool) -> AxProbeResult {
    if !saw_window {
        return AxProbeResult { samples: times_ms.len() as u32, ..empty("no_focused_window") };
    }
    times_ms.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let max = times_ms.last().copied().unwrap_or(0.0);
    AxProbeResult {
        status: "ok",
        samples: times_ms.len() as u32,
        ax_read_ms_p50: round1(percentile(&times_ms, 0.5)),
        ax_read_ms_max: round1(max),
        ax_elements: elements,
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::{empty, summarise, AxProbeResult, MAX_DEPTH, MAX_ELEMENTS, PROBE_WINDOW_MS, SAMPLE_INTERVAL_MS};
    use std::ffi::{c_char, c_void, CString};
    use std::time::{Duration, Instant};

    type CfRef = *const c_void;
    type AxError = i32;
    const AX_ERROR_SUCCESS: AxError = 0;
    /// Returned when a copy succeeds but yields no value (not an AX error code).
    const NO_VALUE: AxError = -1;
    /// The process is not trusted for accessibility (kAXErrorAPIDisabled).
    const AX_ERROR_API_DISABLED: AxError = -25211;
    /// The target did not answer in time (kAXErrorCannotComplete).
    const AX_ERROR_CANNOT_COMPLETE: AxError = -25204;
    const CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;
    /// Per-message timeout on the system-wide element; a hung app fails fast instead of blocking.
    const MESSAGING_TIMEOUT_S: f32 = 0.25;
    /// Hard budget for one tree read.
    const SAMPLE_DEADLINE_MS: u64 = 2_000;
    /// Minimum spacing between reads, so a slow read does not make the next one bunch up.
    const MIN_GAP_MS: u64 = 50;

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrusted() -> u8;
        fn AXUIElementCreateSystemWide() -> CfRef;
        fn AXUIElementSetMessagingTimeout(element: CfRef, timeout: f32) -> AxError;
        fn AXUIElementCopyAttributeValue(element: CfRef, attribute: CfRef, value: *mut CfRef) -> AxError;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFRelease(cf: CfRef);
        fn CFGetTypeID(cf: CfRef) -> usize;
        fn CFArrayGetTypeID() -> usize;
        fn CFArrayGetCount(array: CfRef) -> isize;
        fn CFArrayGetValueAtIndex(array: CfRef, index: isize) -> CfRef;
        fn CFStringCreateWithCString(alloc: CfRef, s: *const c_char, encoding: u32) -> CfRef;
    }

    /// Owns one retained CoreFoundation object and releases it on drop.
    struct Owned(CfRef);

    impl Drop for Owned {
        fn drop(&mut self) {
            if !self.0.is_null() {
                // SAFETY: the pointer was returned by a Copy/Create call, so we own one reference.
                unsafe { CFRelease(self.0) }
            }
        }
    }

    /// Copies one attribute of an AX element; the error code says why it could not be read.
    fn copy_attr(element: CfRef, attribute: CfRef) -> Result<Owned, AxError> {
        let mut out: CfRef = std::ptr::null();
        // SAFETY: `element` and `attribute` are live refs owned by the caller; `out` is written on success.
        let err = unsafe { AXUIElementCopyAttributeValue(element, attribute, &mut out) };
        if err != AX_ERROR_SUCCESS {
            return Err(err);
        }
        if out.is_null() {
            return Err(NO_VALUE);
        }
        Ok(Owned(out))
    }

    /// Attribute-name CFStrings, created once per probe.
    struct Names {
        focused_app: Owned,
        focused_window: Owned,
        role: Owned,
        value: Owned,
        title: Owned,
        children: Owned,
    }

    fn cf_string(name: &str) -> Option<Owned> {
        let c = CString::new(name).ok()?;
        // SAFETY: `c` is a valid NUL-terminated string for the duration of the call.
        let s = unsafe { CFStringCreateWithCString(std::ptr::null(), c.as_ptr(), CF_STRING_ENCODING_UTF8) };
        if s.is_null() {
            None
        } else {
            Some(Owned(s))
        }
    }

    impl Names {
        fn new() -> Option<Names> {
            Some(Names {
                focused_app: cf_string("AXFocusedApplication")?,
                focused_window: cf_string("AXFocusedWindow")?,
                role: cf_string("AXRole")?,
                value: cf_string("AXValue")?,
                title: cf_string("AXTitle")?,
                children: cf_string("AXChildren")?,
            })
        }
    }

    /// Walk state. Only counts are kept; attribute values are read and dropped.
    struct Walk<'a> {
        names: &'a Names,
        count: u64,
        deadline: Instant,
        expired: bool,
    }

    fn walk(element: CfRef, depth: u32, w: &mut Walk<'_>) {
        if w.count >= MAX_ELEMENTS {
            return;
        }
        if Instant::now() >= w.deadline {
            w.expired = true;
            return;
        }
        w.count += 1;
        // Read the role, value and title (the reads are what is timed); contents are dropped here.
        let _role = copy_attr(element, w.names.role.0);
        let _value = copy_attr(element, w.names.value.0);
        let _title = copy_attr(element, w.names.title.0);
        if depth >= MAX_DEPTH {
            return;
        }
        let Ok(children) = copy_attr(element, w.names.children.0) else {
            return;
        };
        // SAFETY: plain type query on a live object.
        let array_type = unsafe { CFArrayGetTypeID() };
        // SAFETY: `children.0` is a live CF object we own.
        if unsafe { CFGetTypeID(children.0) } != array_type {
            return;
        }
        // SAFETY: the type was checked above; the array is alive while `children` is.
        let n = unsafe { CFArrayGetCount(children.0) };
        for i in 0..n {
            if w.count >= MAX_ELEMENTS || w.expired {
                break;
            }
            // SAFETY: `i` is within the count; the array owns the returned child (not retained here).
            let child = unsafe { CFArrayGetValueAtIndex(children.0, i) };
            if !child.is_null() {
                walk(child, depth + 1, w);
            }
        }
    }

    /// One timed read. `error` is set when the focused application itself could not be read.
    struct Sample {
        ms: f64,
        elements: u64,
        had_window: bool,
        error: Option<AxError>,
    }

    /// One timed read: focused app -> focused window -> tree walk (2 s budget).
    fn read_once(system: &Owned, names: &Names) -> Sample {
        let started = Instant::now();
        let mut w = Walk { names, count: 0, deadline: started + Duration::from_millis(SAMPLE_DEADLINE_MS), expired: false };
        let mut had_window = false;
        let mut error = None;
        match copy_attr(system.0, names.focused_app.0) {
            Err(e) => error = Some(e),
            Ok(app) => {
                if let Ok(window) = copy_attr(app.0, names.focused_window.0) {
                    had_window = true;
                    walk(window.0, 0, &mut w);
                }
            }
        }
        Sample { ms: started.elapsed().as_secs_f64() * 1000.0, elements: w.count, had_window, error }
    }

    pub fn probe() -> AxProbeResult {
        // SAFETY: no arguments; reports the process's accessibility trust without prompting.
        if unsafe { AXIsProcessTrusted() } == 0 {
            return empty("permission_denied");
        }
        let Some(names) = Names::new() else {
            return empty("unsupported");
        };
        // SAFETY: creates a system-wide element; released by the `Owned` wrapper.
        let system = Owned(unsafe { AXUIElementCreateSystemWide() });
        if system.0.is_null() {
            return empty("unsupported");
        }
        // SAFETY: sets a per-message timeout on the system-wide element; the result is advisory.
        let _ = unsafe { AXUIElementSetMessagingTimeout(system.0, MESSAGING_TIMEOUT_S) };
        let start = Instant::now();
        let mut times: Vec<f64> = Vec::new();
        let mut elements = 0u64;
        let mut saw_window = false;
        let mut tick = 0u64;
        loop {
            let due = Duration::from_millis(tick * SAMPLE_INTERVAL_MS);
            if due >= Duration::from_millis(PROBE_WINDOW_MS) {
                break;
            }
            if tick > 0 {
                // Wait for the schedule, but never less than MIN_GAP_MS after the previous read.
                let wait = due.saturating_sub(start.elapsed()).max(Duration::from_millis(MIN_GAP_MS));
                std::thread::sleep(wait);
            }
            let sample = read_once(&system, &names);
            match sample.error {
                Some(AX_ERROR_API_DISABLED) => return empty("permission_denied"),
                Some(AX_ERROR_CANNOT_COMPLETE) => return empty("cannot_complete"),
                _ => {}
            }
            times.push(sample.ms);
            elements = elements.max(sample.elements);
            saw_window |= sample.had_window;
            tick += 1;
        }
        summarise(times, elements, saw_window)
    }
}
