//! `notifications/cancelled` stops a running tool's whole process tree, records
//! the run as cancelled, sends no response, and leaves the server serving.
#![cfg(unix)]

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};
use std::{env, fs};

/// The tool: start a grandchild, record both pids, then wait far longer than the test.
const SLEEPER: &str = r#"
import os, subprocess, sys, time
out = os.environ["NEUROFLOW_PID_DIR"]
grandchild = subprocess.Popen(["sleep", "300"])
with open(os.path.join(out, "pids.tmp"), "w") as f:
    f.write(f"{os.getpid()} {grandchild.pid}")
os.rename(os.path.join(out, "pids.tmp"), os.path.join(out, "pids"))
time.sleep(300)
"#;

struct Server {
    child: Child,
    stdin: ChildStdin,
    lines: Receiver<Value>,
    root: PathBuf,
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = fs::remove_dir_all(&self.root);
    }
}

impl Server {
    fn send(&mut self, msg: Value) {
        writeln!(self.stdin, "{msg}").unwrap();
        self.stdin.flush().unwrap();
    }

    /// Every message up to and including the response to `id`.
    fn until_response(&self, id: i64) -> Vec<Value> {
        let deadline = Instant::now() + Duration::from_secs(20);
        let mut seen = vec![];
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            let msg = self
                .lines
                .recv_timeout(left)
                .unwrap_or_else(|_| panic!("no response to request {id}; saw {seen:?}"));
            let done = msg.get("id") == Some(&json!(id));
            seen.push(msg);
            if done {
                return seen;
            }
        }
    }
}

fn find_python() -> Option<PathBuf> {
    env::split_paths(&env::var_os("PATH")?)
        .map(|dir| dir.join("python3"))
        .find(|p| p.is_file())
}

fn alive(pid: &str) -> bool {
    Command::new("kill")
        .args(["-0", pid])
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

fn wait_for(what: &str, mut ready: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !ready() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn run_records(sessions: &Path) -> Vec<Value> {
    fs::read_dir(sessions)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| fs::read_to_string(e.path().join("run.json")).ok())
        .map(|s| serde_json::from_str(&s).unwrap())
        .collect()
}

#[test]
fn a_cancelled_run_stops_its_process_tree_and_the_server_keeps_serving() {
    let Some(python) = find_python() else {
        eprintln!("skipped: python3 is not on PATH");
        return;
    };
    let root = env::temp_dir().join(format!("neuroflow-cancel-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    for dir in ["registry/scripts", "runs", "pids"] {
        fs::create_dir_all(root.join(dir)).unwrap();
    }
    let root = fs::canonicalize(&root).unwrap();
    fs::write(root.join("registry/scripts/sleeper.py"), SLEEPER).unwrap();
    let tool = json!({
        "neuroflow": "0.1.1", "kind": "tool", "id": "test/sleeper", "version": "1.0.0",
        "description": "Sleeps with a grandchild until cancelled.",
        "inputs": {},
        "outputs": { "done": { "type": "core:json", "description": "Never written.",
            "delivery": { "mode": "core:result-file", "path": "done.json" } } },
        "extensions": { "neuroflow/launch": {
            "kind": "script", "interpreter": "python3", "script": "scripts/sleeper.py",
            "completion": "exit", "interactive": false
        } }
    });
    fs::write(root.join("registry/sleeper.json"), tool.to_string()).unwrap();

    let mut child = Command::new(env!("CARGO_BIN_EXE_neuroflow-mcp"))
        .arg("--registry")
        .arg(root.join("registry"))
        .arg("--data-root")
        .arg(&root)
        .arg("--sessions")
        .arg(root.join("runs"))
        .arg("--interpreter")
        .arg(format!("python3={}", python.display()))
        .env("NEUROFLOW_PID_DIR", root.join("pids"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let (tx, lines) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if tx.send(serde_json::from_str(&line).unwrap()).is_err() {
                break;
            }
        }
    });
    let mut server = Server {
        child,
        stdin,
        lines,
        root: root.clone(),
    };

    server.send(json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
        "protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": { "name": "cancel-test", "version": "0" } } }));
    let init = server.until_response(1).pop().unwrap();
    let features =
        &init["result"]["capabilities"]["experimental"]["com.niivue/neuroflow"]["features"];
    assert!(
        features
            .as_array()
            .unwrap()
            .contains(&json!("cancellation")),
        "{init}"
    );
    server.send(json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }));

    server.send(json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/call",
        "params": { "name": "test.sleeper", "arguments": {} } }));
    let pid_file = root.join("pids/pids");
    wait_for("the tool to start", || pid_file.exists());
    let pids = fs::read_to_string(&pid_file).unwrap();
    let pids: Vec<&str> = pids.split_whitespace().collect();
    assert_eq!(pids.len(), 2, "{pids:?}");
    assert!(pids.iter().all(|pid| alive(pid)));

    let cancelled_at = Instant::now();
    server.send(
        json!({ "jsonrpc": "2.0", "method": "notifications/cancelled",
        "params": { "requestId": 2, "reason": "user stopped the run" } }),
    );
    server.send(json!({ "jsonrpc": "2.0", "id": 3, "method": "ping" }));
    let seen = server.until_response(3);
    assert!(
        cancelled_at.elapsed() < Duration::from_secs(10),
        "cancel took {:?}",
        cancelled_at.elapsed()
    );
    assert!(
        seen.iter().all(|m| m.get("id") != Some(&json!(2))),
        "the cancelled request was answered: {seen:?}"
    );
    for pid in &pids {
        wait_for(&format!("process {pid} to exit"), || !alive(pid));
    }

    let records = run_records(&root.join("runs"));
    assert_eq!(records.len(), 1, "{records:?}");
    assert_eq!(records[0]["status"], json!("cancelled"), "{}", records[0]);

    // Still serving: a later request is answered.
    server.send(json!({ "jsonrpc": "2.0", "id": 4, "method": "tools/list" }));
    let list = server.until_response(4).pop().unwrap();
    assert!(list["result"]["tools"].is_array(), "{list}");
}
