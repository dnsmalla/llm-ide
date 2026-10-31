//! Spawn a child as the root of its own process tree and stop the WHOLE tree.
//!
//! The Node core spawns children of its own (the user's `claude` CLI, git, MCP servers).
//! Killing only the Node pid would leave those orphaned, so:
//! - unix: the child leads a new process group (`process_group(0)`); stopping sends
//!   SIGTERM to the group, waits up to `grace` for the leader, then SIGKILLs the group
//!   (also when the leader exited but a member ignored SIGTERM). A grandchild that
//!   deliberately `setsid`s itself leaves the group and is out of reach; the core does
//!   not do that.
//! - windows: the child is assigned to a Job Object with KILL_ON_JOB_CLOSE, so
//!   terminating the job (or the host dying, which closes the handle) kills the tree.
//!   There is no graceful signal for a console-less process. A grandchild spawned in the
//!   few milliseconds before the assignment is not in the job (std cannot create the
//!   child suspended); node's own startup is far slower than that.

use std::io;
use std::process::{Child, Command, ExitStatus};
#[cfg(unix)]
use std::thread;
use std::time::Duration;
#[cfg(unix)]
use std::time::Instant;

pub struct ManagedChild {
    child: Child,
    #[cfg(windows)]
    job: win::Job,
}

impl ManagedChild {
    pub fn spawn(cmd: &mut Command) -> io::Result<Self> {
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let child = cmd.spawn()?;
        #[cfg(windows)]
        {
            let job = win::Job::new_for(&child);
            let job = match job {
                Ok(j) => j,
                Err(e) => {
                    let mut c = child;
                    let _ = c.kill();
                    let _ = c.wait();
                    return Err(e);
                }
            };
            Ok(Self { child, job })
        }
        #[cfg(not(windows))]
        Ok(Self { child })
    }

    pub fn id(&self) -> u32 {
        self.child.id()
    }

    pub fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        self.child.try_wait()
    }

    pub fn child_mut(&mut self) -> &mut Child {
        &mut self.child
    }

    /// Stops the whole tree: graceful first (unix), then forced. Always reaps the leader.
    pub fn terminate(mut self, grace: Duration) {
        #[cfg(unix)]
        {
            let pgid = self.child.id() as libc::pid_t;
            // SAFETY: signalling a process group we created and have not yet reaped
            // (the unreaped leader keeps the group id reserved).
            let signal = |sig: libc::c_int| unsafe {
                libc::kill(-pgid, sig);
            };
            if matches!(self.child.try_wait(), Ok(None)) {
                signal(libc::SIGTERM);
                let deadline = Instant::now() + grace;
                while Instant::now() < deadline && matches!(self.child.try_wait(), Ok(None)) {
                    thread::sleep(Duration::from_millis(25));
                }
            }
            // Members that outlived the leader (or ignored SIGTERM) die here; ESRCH when none are left.
            signal(libc::SIGKILL);
            let _ = self.child.wait();
        }
        #[cfg(windows)]
        {
            let _ = grace;
            self.job.terminate();
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

#[cfg(windows)]
mod win {
    use std::io;
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;

    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
        TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    pub struct Job(HANDLE);
    // SAFETY: a job handle is a plain kernel handle usable from any thread.
    unsafe impl Send for Job {}

    impl Job {
        pub fn new_for(child: &Child) -> io::Result<Job> {
            // SAFETY: plain Win32 calls with valid arguments; the handle is closed in Drop.
            unsafe {
                let h = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if h.is_null() {
                    return Err(io::Error::last_os_error());
                }
                let job = Job(h);
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                if SetInformationJobObject(
                    h,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const _,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                ) == 0
                {
                    return Err(io::Error::last_os_error());
                }
                if AssignProcessToJobObject(h, child.as_raw_handle() as HANDLE) == 0 {
                    return Err(io::Error::last_os_error());
                }
                Ok(job)
            }
        }

        pub fn terminate(&self) {
            // SAFETY: valid job handle.
            unsafe {
                TerminateJobObject(self.0, 1);
            }
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            // KILL_ON_JOB_CLOSE: closing the last handle kills anything still in the job.
            // SAFETY: handle owned by this struct.
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::process::Stdio;

    fn alive(pid: i32) -> bool {
        // SAFETY: signal 0 only checks existence. A zombie still "exists"; reaped by init quickly.
        unsafe { libc::kill(pid, 0) == 0 }
    }

    fn wait_dead(pids: &[i32]) -> bool {
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if pids.iter().all(|p| !alive(*p)) {
                return true;
            }
            thread::sleep(Duration::from_millis(50));
        }
        false
    }

    /// Starts `sh -c script`, which prints the leader and two grandchild pids.
    fn spawn_tree(script: &str) -> (ManagedChild, Vec<i32>) {
        let mut cmd = Command::new("sh");
        cmd.arg("-c").arg(script).stdout(Stdio::piped()).stdin(Stdio::null());
        let mut c = ManagedChild::spawn(&mut cmd).unwrap();
        let out = c.child_mut().stdout.take().unwrap();
        let mut line = String::new();
        BufReader::new(out).read_line(&mut line).unwrap();
        let pids: Vec<i32> = line.split_whitespace().map(|p| p.parse().unwrap()).collect();
        assert_eq!(pids.len(), 3, "line: {line:?}");
        (c, pids)
    }

    #[test]
    fn terminate_kills_grandchildren_too() {
        let (c, pids) = spawn_tree("sleep 300 & a=$!; sleep 301 & b=$!; echo $$ $a $b; wait");
        assert!(pids.iter().all(|p| alive(*p)));
        c.terminate(Duration::from_secs(2));
        assert!(wait_dead(&pids), "orphans survived: {pids:?}");
    }

    #[test]
    fn terminate_escalates_to_kill_when_sigterm_is_ignored() {
        // The shell and its children ignore TERM, so only the SIGKILL escalation works.
        let (c, pids) = spawn_tree("trap '' TERM; sleep 300 & a=$!; sleep 301 & b=$!; echo $$ $a $b; while :; do sleep 1; done");
        let started = Instant::now();
        c.terminate(Duration::from_millis(300));
        assert!(started.elapsed() < Duration::from_secs(4));
        assert!(wait_dead(&pids), "stubborn tree survived: {pids:?}");
    }

    #[test]
    fn terminate_after_the_leader_already_exited_still_reaps_members() {
        // Leader exits at once; the member keeps running in the group.
        let (c, pids) = spawn_tree("sleep 300 & a=$!; sleep 301 & b=$!; echo $$ $a $b");
        thread::sleep(Duration::from_millis(200));
        c.terminate(Duration::from_secs(1));
        assert!(wait_dead(&pids), "members outlived their leader: {pids:?}");
    }
}
