//! The desktop builder's runner: settings, the up-front environment check, and
//! in-process workflow runs on the neuroflow-mcp runtime.
//!
//! Runs execute on a background thread and report through two events:
//! `neuroflow:run-progress` { ticket, progress, total, message } and
//! `neuroflow:run-finished` { ticket, ok, runId, status, structured, summary,
//! error, record } where `record` is the session's run.json.

use neuroflow_mcp::registry::{Kind, Registry};
use neuroflow_mcp::util::find_on_path;
use neuroflow_mcp::{runtime, Config};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Emitter};

/// Where the host looks for documents, data and sessions. Persisted by the UI.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostSettings {
    pub registry_dirs: Vec<String>,
    pub data_roots: Vec<String>,
    pub sessions_root: String,
    #[serde(default)]
    pub interpreters: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InterpreterStatus {
    pub name: String,
    pub path: Option<String>,
    pub version: Option<String>,
    pub required_by: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolStatus {
    pub id: String,
    pub adapter: Option<String>,
    /// ready | needsSetup | interactive | unsupported
    pub status: String,
    pub detail: String,
    pub fix: Option<String>,
    pub executable: Option<String>,
    pub version: Option<String>,
    pub packages: Option<Value>,
    pub source: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentReport {
    pub checked_at: String,
    pub registry_dirs: Vec<String>,
    pub sessions_root: String,
    pub data_roots: Vec<String>,
    pub interpreters: Vec<InterpreterStatus>,
    pub tools: Vec<ToolStatus>,
    pub workflows: Vec<WorkflowStatus>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowStatus {
    pub id: String,
    /// Ok when every step can run here; otherwise the first reason.
    pub runnable: Option<String>,
}

const SUMMARY_MAX_BYTES: u64 = 512 * 1024 * 1024;
static TICKETS: AtomicU64 = AtomicU64::new(1);

fn home() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(std::env::temp_dir)
}

fn gallery_dir() -> PathBuf {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("gallery");
    dir.canonicalize().unwrap_or(dir)
}

#[tauri::command]
pub fn default_settings() -> HostSettings {
    HostSettings {
        registry_dirs: vec![gallery_dir().to_string_lossy().into_owned()],
        data_roots: vec![home().to_string_lossy().into_owned()],
        sessions_root: home().join(".neuroflow").join("runs").to_string_lossy().into_owned(),
        interpreters: HashMap::new(),
    }
}

fn expand(path: &str) -> PathBuf {
    match path.strip_prefix("~/") {
        Some(rest) => home().join(rest),
        None => PathBuf::from(path),
    }
}

fn build_config(settings: &HostSettings) -> Result<Config, String> {
    if settings.registry_dirs.is_empty() {
        return Err("at least one registry folder is required".into());
    }
    let sessions = expand(&settings.sessions_root);
    std::fs::create_dir_all(&sessions).map_err(|e| format!("cannot create sessions folder {}: {e}", sessions.display()))?;
    let mut data_roots = Vec::new();
    for root in &settings.data_roots {
        let p = expand(root);
        data_roots.push(p.canonicalize().map_err(|e| format!("data root {}: {e}", p.display()))?);
    }
    let mut interpreters = HashMap::new();
    for (name, path) in &settings.interpreters {
        if path.trim().is_empty() {
            continue;
        }
        let p = expand(path);
        if !p.is_file() {
            return Err(format!("interpreter {name} is set to {}, which does not exist", p.display()));
        }
        interpreters.insert(name.clone(), p);
    }
    Ok(Config {
        registry_dirs: settings.registry_dirs.iter().map(|d| expand(d)).collect(),
        spec_dir: None,
        data_roots,
        sessions_root: sessions.canonicalize().unwrap_or(sessions),
        interpreters,
        step_timeout: None,
        summary_max_bytes: SUMMARY_MAX_BYTES,
    })
}

fn load_registry(cfg: &Config) -> Result<Registry, String> {
    Registry::load(&cfg.registry_dirs, &cfg.interpreters)
}

fn version_of(path: &Path, args: &[&str]) -> Option<String> {
    let out = Command::new(path).args(args).output().ok()?;
    let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    text.lines().next().map(|l| l.trim().to_string()).filter(|l| !l.is_empty())
}

/// Locate the environment checker: next to the registry's adapters, or the repo's copy.
fn checker_script(cfg: &Config) -> Option<PathBuf> {
    cfg.registry_dirs
        .iter()
        .map(|d| d.join("scripts").join("check_tool.mjs"))
        .chain(std::iter::once(gallery_dir().join("scripts").join("check_tool.mjs")))
        .find(|p| p.is_file())
}

#[tauri::command]
pub fn check_environment(settings: HostSettings) -> Result<EnvironmentReport, String> {
    let cfg = build_config(&settings)?;
    let registry = load_registry(&cfg)?;
    let mut warnings = registry.warnings.clone();

    // Interpreters the launch extensions name, resolved the way the runtime resolves them.
    let mut required: HashMap<String, Vec<String>> = HashMap::new();
    for doc in registry.docs.iter().filter(|d| d.kind == Kind::Tool) {
        if let Some(name) = doc.value.pointer("/extensions/neuroflow~1launch/interpreter").and_then(Value::as_str) {
            required.entry(name.to_string()).or_default().push(doc.id.clone());
        }
    }
    let mut names: Vec<String> = required.keys().cloned().collect();
    for extra in ["node", "python3"] {
        if !names.iter().any(|n| n == extra) {
            names.push(extra.to_string());
        }
    }
    names.sort();
    let interpreters: Vec<InterpreterStatus> = names
        .iter()
        .map(|name| {
            let path = cfg.interpreters.get(name).cloned().or_else(|| {
                if name == "python3" {
                    std::env::var_os("NEUROFLOW_PYTHON").map(PathBuf::from).filter(|p| p.is_file())
                } else {
                    None
                }
                .or_else(|| find_on_path(name))
            });
            InterpreterStatus {
                name: name.clone(),
                version: path.as_deref().and_then(|p| version_of(p, &["--version"])),
                path: path.map(|p| p.to_string_lossy().into_owned()),
                required_by: required.get(name).cloned().unwrap_or_default(),
            }
        })
        .collect();

    // Per-tool probes through check_tool.mjs, one node process for every tool.
    let node = interpreters.iter().find(|i| i.name == "node").and_then(|i| i.path.clone()).map(PathBuf::from);
    let tool_docs: Vec<_> = registry.docs.iter().filter(|d| d.kind == Kind::Tool).collect();
    let mut probed: HashMap<String, Value> = HashMap::new();
    match (node, checker_script(&cfg)) {
        (Some(node), Some(script)) if !tool_docs.is_empty() => {
            let out = Command::new(&node)
                .arg(&script)
                .args(tool_docs.iter().map(|d| &d.source))
                .output()
                .map_err(|e| format!("cannot start {}: {e}", node.display()))?;
            if !out.status.success() {
                warnings.push(format!(
                    "environment check exited with status {}: {}",
                    out.status.code().unwrap_or(1),
                    String::from_utf8_lossy(&out.stderr).trim()
                ));
            }
            if let Ok(Value::Array(items)) = serde_json::from_slice::<Value>(&out.stdout) {
                for item in items {
                    if let Some(id) = item.get("id").and_then(Value::as_str) {
                        probed.insert(id.to_string(), item);
                    }
                }
            }
        }
        (None, _) => warnings.push("node was not found on PATH; install Node.js 20 or newer (https://nodejs.org) or set the node interpreter in settings".into()),
        (_, None) => warnings.push("scripts/check_tool.mjs was not found in any registry folder; per-tool probes skipped".into()),
        _ => {}
    }

    let str_of = |v: &Value, key: &str| v.get(key).and_then(Value::as_str).map(str::to_string);
    let tools = tool_docs
        .iter()
        .map(|doc| {
            let probe = probed.get(&doc.id);
            let mut status = ToolStatus {
                id: doc.id.clone(),
                adapter: probe.and_then(|p| str_of(p, "adapter")),
                status: probe.and_then(|p| str_of(p, "status")).unwrap_or_else(|| "needsSetup".into()),
                detail: probe.and_then(|p| str_of(p, "detail")).unwrap_or_else(|| "not probed: node is needed to run the environment check".into()),
                fix: probe.and_then(|p| str_of(p, "fix")),
                executable: probe.and_then(|p| str_of(p, "executable")),
                version: probe.and_then(|p| str_of(p, "version")),
                packages: probe.and_then(|p| p.get("packages").cloned()).filter(|p| !p.is_null()),
                source: doc.source.to_string_lossy().into_owned(),
            };
            // The runtime's own gate wins over a ready probe (missing interpreter, script outside the registry...).
            if let Err(reason) = &doc.runnable {
                if status.status == "ready" {
                    status.status = "needsSetup".into();
                    status.detail = reason.clone();
                }
            }
            status
        })
        .collect();

    let workflows = registry
        .docs
        .iter()
        .filter(|d| d.kind == Kind::Workflow)
        .map(|d| WorkflowStatus { id: d.id.clone(), runnable: registry.workflow_runnable(&d.value).err() })
        .collect();

    Ok(EnvironmentReport {
        checked_at: neuroflow_mcp::util::now_rfc3339(),
        registry_dirs: cfg.registry_dirs.iter().map(|d| d.to_string_lossy().into_owned()).collect(),
        sessions_root: cfg.sessions_root.to_string_lossy().into_owned(),
        data_roots: cfg.data_roots.iter().map(|d| d.to_string_lossy().into_owned()).collect(),
        interpreters,
        tools,
        workflows,
        warnings,
    })
}

/// Why this workflow cannot run here, or None when it can. Cheap: no probes.
#[tauri::command]
pub fn workflow_runnable(settings: HostSettings, workflow: Value) -> Result<Option<String>, String> {
    let cfg = build_config(&settings)?;
    let registry = load_registry(&cfg)?;
    Ok(registry.workflow_runnable(&workflow).err())
}

#[tauri::command]
pub fn start_run(app: AppHandle, settings: HostSettings, workflow: Value, inputs: Map<String, Value>) -> Result<String, String> {
    let cfg = build_config(&settings)?;
    let registry = load_registry(&cfg)?;
    let ticket = format!("run-{}", TICKETS.fetch_add(1, Ordering::SeqCst));
    let emitter = app.clone();
    let ticket_out = ticket.clone();
    std::thread::Builder::new()
        .name(format!("neuroflow-{ticket}"))
        .spawn(move || {
            let client = json!({ "name": "neuroflow-desktop", "version": env!("CARGO_PKG_VERSION") });
            let mut progress = |done: f64, total: f64, message: &str| {
                let _ = emitter.emit(
                    "neuroflow:run-progress",
                    json!({ "ticket": ticket, "progress": done, "total": total, "message": message }),
                );
            };
            let payload = match runtime::run_workflow(&cfg, &registry, &workflow, &inputs, &client, &mut progress) {
                Err(e) => json!({ "ticket": ticket, "ok": false, "error": format!("Run rejected before any step started: {e}") }),
                Ok(outcome) => {
                    let record = std::fs::read_to_string(cfg.sessions_root.join(&outcome.run_id).join("run.json"))
                        .ok()
                        .and_then(|t| serde_json::from_str::<Value>(&t).ok());
                    json!({
                        "ticket": ticket,
                        "ok": !outcome.is_error(),
                        "runId": outcome.run_id,
                        "status": outcome.status,
                        "structured": outcome.structured,
                        "summary": outcome.summary,
                        "sessionDir": cfg.sessions_root.join(&outcome.run_id),
                        "record": record,
                    })
                }
            };
            let _ = emitter.emit("neuroflow:run-finished", payload);
        })
        .map_err(|e| format!("cannot start the run thread: {e}"))?;
    Ok(ticket_out)
}

/// Reveal a file or folder from a run session in the system file manager.
#[tauri::command]
pub fn open_path(settings: HostSettings, path: String) -> Result<(), String> {
    let cfg = build_config(&settings)?;
    let target = PathBuf::from(&path).canonicalize().map_err(|e| format!("{path}: {e}"))?;
    if !target.starts_with(&cfg.sessions_root) && !cfg.data_roots.iter().any(|r| target.starts_with(r)) {
        return Err(format!("{} is outside the sessions folder and data roots", target.display()));
    }
    let status = if cfg!(target_os = "macos") {
        Command::new("open").arg(if target.is_dir() { "" } else { "-R" }).arg(&target).status()
    } else if cfg!(target_os = "windows") {
        Command::new("explorer").arg(&target).status()
    } else {
        Command::new("xdg-open").arg(if target.is_dir() { target.clone() } else { target.parent().map(Path::to_path_buf).unwrap_or(target.clone()) }).status()
    };
    status.map_err(|e| format!("cannot open {}: {e}", target.display()))?;
    Ok(())
}

/// The last `max_bytes` of a session file (a step's stderr, for the failure box).
#[tauri::command]
pub fn read_session_tail(settings: HostSettings, path: String, max_bytes: Option<u64>) -> Result<String, String> {
    let cfg = build_config(&settings)?;
    let target = PathBuf::from(&path).canonicalize().map_err(|e| format!("{path}: {e}"))?;
    if !target.starts_with(&cfg.sessions_root) {
        return Err(format!("{} is outside the sessions folder", target.display()));
    }
    let bytes = std::fs::read(&target).map_err(|e| format!("{}: {e}", target.display()))?;
    let max = max_bytes.unwrap_or(16 * 1024) as usize;
    let start = bytes.len().saturating_sub(max);
    Ok(String::from_utf8_lossy(&bytes[start..]).into_owned())
}
