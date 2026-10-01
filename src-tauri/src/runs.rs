//! Agent CLI runs in flight.
//!
//! A review is one long CLI process (two, when claude has to wrap up), and the
//! network under it can stall for minutes at a time. So every run is kept here
//! under an id the page chose, which lets the page cancel it; it is stopped
//! when it goes quiet for too long or runs past a ceiling; and the page hears
//! each time the CLI writes anything, so it can show whether the run is still
//! doing something or has gone silent.

use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::process::{Child, Command, Output};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

/// A CLI that has written nothing for this long is stuck rather than slow.
/// Codex waits five minutes on a silent stream before it retries, and says so
/// when it does, so even a run waiting out a bad network writes something
/// every five minutes. Keep in step with `QUIET_LIMIT_MINUTES` in
/// `src/components/RunProgress/RunProgress.tsx`.
pub const QUIET_LIMIT: Duration = Duration::from_secs(15 * 60);

/// A run is stopped past this, whatever it is doing. The longest healthy
/// review seen took about three quarters of an hour, on a slow network.
pub const RUN_LIMIT: Duration = Duration::from_secs(60 * 60);

/// How often a waiting run checks on its process and its cancel flag.
const POLL: Duration = Duration::from_millis(200);

/// The page hears about output at most this often, however chatty the CLI.
const NOTIFY_EVERY: Duration = Duration::from_secs(1);

/// How long a stopped process gets to exit on its own before it is killed.
const KILL_GRACE: Duration = Duration::from_secs(2);

/// How long to keep reading once the process has exited. Anything it started
/// holds the output pipes open until it exits too, and nothing a leftover
/// helper writes is worth waiting on.
const DRAIN_LIMIT: Duration = Duration::from_secs(5);

/// Why a run was stopped before its process could finish on its own.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stop {
    Cancelled,
    /// Nothing written for the run's quiet limit.
    Quiet,
    /// Still going at the run's time limit.
    TooLong,
}

/// A process the run waited on: everything it wrote, and whether it was
/// stopped rather than left to finish.
pub struct Finished {
    pub output: Output,
    pub stopped: Option<Stop>,
}

/// What other threads reach while the run's own thread waits on its process:
/// `cancel` from the page, and `kill_all` as the app exits.
#[derive(Default)]
struct RunState {
    cancelled: AtomicBool,
    /// The process running now. A run can go through more than one, one after
    /// another.
    pid: Mutex<Option<u32>>,
}

/// The runs in flight, kept as app state.
#[derive(Default, Clone)]
pub struct AgentRuns {
    runs: Arc<Mutex<HashMap<String, Arc<RunState>>>>,
}

impl AgentRuns {
    /// Registers a run under the page's id. `on_output` is called, at most
    /// once a second, while its CLI is writing. The run leaves the registry
    /// when the returned `AgentRun` is dropped, however it ended.
    pub fn start(&self, id: String, on_output: impl Fn() + Send + Sync + 'static) -> AgentRun {
        let state = Arc::new(RunState::default());
        lock(&self.runs).insert(id.clone(), state.clone());
        AgentRun {
            id,
            state,
            registry: self.clone(),
            on_output: Box::new(on_output),
            started: Instant::now(),
            quiet_limit: QUIET_LIMIT,
            run_limit: RUN_LIMIT,
        }
    }

    /// Asks a run to stop. Its own thread kills the process at its next check,
    /// and the run ends in `GitError::Cancelled`.
    pub fn cancel(&self, id: &str) {
        if let Some(state) = lock(&self.runs).get(id) {
            state.cancelled.store(true, Ordering::SeqCst);
        }
    }

    /// Cancels every run, for when the page that started them has gone.
    pub fn cancel_all(&self) {
        for state in lock(&self.runs).values() {
            state.cancelled.store(true, Ordering::SeqCst);
        }
    }

    /// Kills every run's process and whatever it started, now. For the app's
    /// exit, when the runs' own threads won't get another look: a CLI that
    /// outlived the app would go on working, and spending, for nobody.
    pub fn kill_all(&self) {
        let mut pids = Vec::new();
        for state in lock(&self.runs).values() {
            state.cancelled.store(true, Ordering::SeqCst);
            if let Some(pid) = *lock(&state.pid) {
                pids.extend(with_descendants(pid));
            }
        }
        if pids.is_empty() {
            return;
        }
        signal(&pids, libc::SIGTERM);
        thread::sleep(Duration::from_millis(300));
        signal(&pids, libc::SIGKILL);
    }
}

/// One run in flight: what a CLI call needs to wait on its process in a way
/// the page can see and stop.
pub struct AgentRun {
    id: String,
    state: Arc<RunState>,
    registry: AgentRuns,
    on_output: Box<dyn Fn() + Send + Sync>,
    started: Instant,
    quiet_limit: Duration,
    run_limit: Duration,
}

impl Drop for AgentRun {
    fn drop(&mut self) {
        let mut runs = lock(&self.registry.runs);
        // The page may have reused the id for a newer run by now.
        if runs
            .get(&self.id)
            .is_some_and(|state| Arc::ptr_eq(state, &self.state))
        {
            runs.remove(&self.id);
        }
    }
}

impl AgentRun {
    /// A run no page is watching or can cancel, which only the limits stop.
    pub fn detached() -> Self {
        AgentRuns::default().start(String::new(), || {})
    }

    pub fn is_cancelled(&self) -> bool {
        self.state.cancelled.load(Ordering::SeqCst)
    }

    /// Feeds `input` to `child`'s stdin, collects both output streams, and
    /// waits for it to exit. If the run is cancelled, goes quiet, or runs too
    /// long first, the process and everything it started are stopped, and the
    /// result says why.
    pub fn wait(&self, mut child: Child, input: &str) -> io::Result<Finished> {
        *lock(&self.state.pid) = Some(child.id());
        let finished = self.supervise(&mut child, input);
        *lock(&self.state.pid) = None;
        finished
    }

    fn supervise(&self, child: &mut Child, input: &str) -> io::Result<Finished> {
        // From its own thread: a CLI that writes before it has read all of its
        // input would otherwise fill a pipe and stall both sides. A failed
        // write means the process has exited, and its exit says why.
        if let Some(mut stdin) = child.stdin.take() {
            let input = input.to_owned();
            thread::spawn(move || {
                let _ = stdin.write_all(input.as_bytes());
            });
        }

        let spawned = Instant::now();
        let last_output = Arc::new(Mutex::new(spawned));
        let stdout = Arc::new(Mutex::new(Vec::new()));
        let stderr = Arc::new(Mutex::new(Vec::new()));
        let (closed, streams_closed) = mpsc::channel::<()>();
        if let Some(stream) = child.stdout.take() {
            read_into(stream, stdout.clone(), last_output.clone(), closed.clone());
        }
        if let Some(stream) = child.stderr.take() {
            read_into(stream, stderr.clone(), last_output.clone(), closed.clone());
        }
        drop(closed);

        let mut noticed = spawned;
        let mut notified_at: Option<Instant> = None;
        let stopped = loop {
            if child.try_wait()?.is_some() {
                break None;
            }
            let now = Instant::now();
            let output_at = *lock(&last_output);
            if self.is_cancelled() {
                break Some(Stop::Cancelled);
            }
            if now.duration_since(output_at) >= self.quiet_limit {
                break Some(Stop::Quiet);
            }
            if now.duration_since(self.started) >= self.run_limit {
                break Some(Stop::TooLong);
            }
            let due = notified_at.map_or(true, |at| now.duration_since(at) >= NOTIFY_EVERY);
            if output_at > noticed && due {
                (self.on_output)();
                noticed = output_at;
                notified_at = Some(now);
            }
            thread::sleep(POLL);
        };
        if stopped.is_some() {
            kill_tree(child);
        }
        let status = child.wait()?;

        let deadline = Instant::now() + DRAIN_LIMIT;
        while streams_closed
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .is_ok()
        {}
        let take = |stream: &Arc<Mutex<Vec<u8>>>| std::mem::take(&mut *lock(stream));
        Ok(Finished {
            output: Output {
                status,
                stdout: take(&stdout),
                stderr: take(&stderr),
            },
            stopped,
        })
    }
}

/// Copies `stream` into `buffer` on its own thread, noting the time of each
/// read, and says on `closed` when the stream has ended.
fn read_into(
    mut stream: impl Read + Send + 'static,
    buffer: Arc<Mutex<Vec<u8>>>,
    last_output: Arc<Mutex<Instant>>,
    closed: mpsc::Sender<()>,
) {
    thread::spawn(move || {
        let mut chunk = [0; 8192];
        loop {
            match stream.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    lock(&buffer).extend_from_slice(&chunk[..read]);
                    *lock(&last_output) = Instant::now();
                }
            }
        }
        let _ = closed.send(());
    });
}

/// Stops `child` and everything it started (an npm shim, the CLI it launches,
/// that CLI's helpers): asks them all to exit, then kills whatever is left.
/// They are found before any is signalled, while they are still linked to the
/// child: once it exits, its children belong to launchd.
fn kill_tree(child: &mut Child) {
    let pids = with_descendants(child.id());
    signal(&pids, libc::SIGTERM);
    let deadline = Instant::now() + KILL_GRACE;
    while Instant::now() < deadline {
        if matches!(child.try_wait(), Ok(Some(_))) {
            break;
        }
        thread::sleep(Duration::from_millis(50));
    }
    signal(&pids, libc::SIGKILL);
}

/// `pid` and every process under it, read from `ps`. Just `pid` if `ps`
/// can't be read, which still stops the process itself.
fn with_descendants(pid: u32) -> Vec<u32> {
    let listing = Command::new("ps")
        .args(["-A", "-o", "pid=,ppid="])
        .output()
        .map(|output| String::from_utf8_lossy(&output.stdout).into_owned())
        .unwrap_or_default();
    let pairs: Vec<(u32, u32)> = listing
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace().map(str::parse::<u32>);
            Some((fields.next()?.ok()?, fields.next()?.ok()?))
        })
        .collect();

    let mut found = vec![pid];
    let mut next = 0;
    while let Some(&parent) = found.get(next) {
        found.extend(
            pairs
                .iter()
                .filter(|&&(child, ppid)| ppid == parent && !found.contains(&child))
                .map(|&(child, _)| child)
                .collect::<Vec<_>>(),
        );
        next += 1;
    }
    found
}

fn signal(pids: &[u32], signal: libc::c_int) {
    for &pid in pids {
        let Ok(pid) = libc::pid_t::try_from(pid) else {
            continue;
        };
        // SAFETY: `kill` takes plain integers and touches no memory of ours. A
        // process that has already gone makes it fail harmlessly with ESRCH.
        unsafe {
            libc::kill(pid, signal);
        }
    }
}

/// The lock, even if a thread panicked while holding it: every value behind
/// these locks is valid at any point it could be left.
fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Stdio;
    use std::sync::atomic::AtomicUsize;

    fn sh(script: &str) -> Child {
        Command::new("sh")
            .args(["-c", script])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("sh")
    }

    fn alive(pid: u32) -> bool {
        // SAFETY: signal 0 only checks that the process exists.
        unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
    }

    #[test]
    fn a_finished_process_hands_back_what_it_wrote() {
        let run = AgentRun::detached();
        let finished = run
            .wait(sh("cat; echo done >&2"), "the prompt")
            .expect("wait");
        assert_eq!(finished.stopped, None);
        assert!(finished.output.status.success());
        assert_eq!(finished.output.stdout, b"the prompt");
        assert_eq!(finished.output.stderr, b"done\n");
    }

    #[test]
    fn cancelling_stops_the_process_and_what_it_started() {
        let runs = AgentRuns::default();
        let run = runs.start("review".into(), || {});
        // The helper stands in for codex's own children: it has to go too.
        let child = sh("sleep 60 & echo $!; wait");
        let canceller = runs.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(500));
            canceller.cancel("review");
        });

        let started = Instant::now();
        let finished = run.wait(child, "").expect("wait");
        assert_eq!(finished.stopped, Some(Stop::Cancelled));
        assert!(started.elapsed() < Duration::from_secs(10));
        let helper: u32 = String::from_utf8_lossy(&finished.output.stdout)
            .trim()
            .parse()
            .expect("the helper's pid");
        let gone_by = Instant::now() + Duration::from_secs(2);
        while alive(helper) && Instant::now() < gone_by {
            thread::sleep(Duration::from_millis(50));
        }
        assert!(!alive(helper), "the helper outlived the cancel");
    }

    #[test]
    fn a_process_that_goes_quiet_is_stopped() {
        let mut run = AgentRun::detached();
        run.quiet_limit = Duration::from_millis(600);
        let finished = run.wait(sh("echo started; sleep 60"), "").expect("wait");
        assert_eq!(finished.stopped, Some(Stop::Quiet));
        // What it wrote before it went quiet is kept for the error's detail.
        assert_eq!(finished.output.stdout, b"started\n");
    }

    #[test]
    fn a_process_that_keeps_writing_is_stopped_at_the_run_limit() {
        let mut run = AgentRun::detached();
        run.quiet_limit = Duration::from_millis(600);
        run.run_limit = Duration::from_millis(1500);
        let finished = run
            .wait(sh("while true; do echo working; sleep 0.1; done"), "")
            .expect("wait");
        assert_eq!(finished.stopped, Some(Stop::TooLong));
    }

    #[test]
    fn output_is_reported_while_the_process_writes() {
        let calls = Arc::new(AtomicUsize::new(0));
        let counted = calls.clone();
        let run = AgentRuns::default().start("review".into(), move || {
            counted.fetch_add(1, Ordering::SeqCst);
        });
        let finished = run
            .wait(sh("for i in 1 2 3; do echo $i; sleep 0.6; done"), "")
            .expect("wait");
        assert_eq!(finished.stopped, None);
        assert!(calls.load(Ordering::SeqCst) >= 1);
    }

    #[test]
    fn a_finished_run_leaves_the_registry() {
        let runs = AgentRuns::default();
        let run = runs.start("review".into(), || {});
        assert!(lock(&runs.runs).contains_key("review"));
        drop(run);
        assert!(lock(&runs.runs).is_empty());
    }
}
