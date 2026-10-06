//! Minimal NeuroFlow runtime: resolves inputs, runs `script` tools under the
//! file-based session contract (docs/neuroflow-session-contract.md), harvests
//! outputs per RFC 0008, and writes a provenance document (RFC 0003).

use crate::{artifacts, qualifiers};
use crate::registry::{interpreter_env, launch_of, Doc, Registry};
use crate::schema::{element_type, is_array_type, is_artifact_type, is_directory_type, value_types_of};
use crate::util::{new_run_id, now_rfc3339, to_local_id, within_any};
use crate::Config;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// The failure message a cancellation leaves on the step and the run; the
/// final status is derived from it, not from the live flag, so a cancel that
/// arrives after the last step finished does not relabel a completed run.
const CANCELLED: &str = "run cancelled";

pub struct RunOutcome {
    pub run_id: String,
    pub status: String,
    /// `structuredContent` for the MCP result (RFC 0009 section 1.4).
    pub structured: Value,
    /// Artifact links: (uri, name, mediaType, description).
    pub links: Vec<(String, String, String, String)>,
    pub summary: String,
}

impl RunOutcome {
    pub fn is_error(&self) -> bool {
        self.status != "completed"
    }
}

/// Progress callback: (progress, total, message).
pub type Progress<'a> = &'a mut dyn FnMut(f64, f64, &str);

/// Wrap a single tool document as a one-step workflow.
pub fn wrap_tool(tool: &Doc) -> Value {
    let step = to_local_id(tool.id.rsplit('/').next().unwrap_or("step"));
    let inputs = tool.value.get("inputs").cloned().unwrap_or_else(|| json!({}));
    let bindings: Map<String, Value> = inputs
        .as_object()
        .into_iter()
        .flatten()
        .map(|(name, _)| (name.clone(), json!({ "ref": format!("inputs.{name}") })))
        .collect();
    let outputs: Map<String, Value> = tool
        .value
        .get("outputs")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .map(|(name, decl)| {
            let out = json!({ "type": decl.get("type").cloned().unwrap_or(json!("core:json")),
                                  "ref": format!("steps.{step}.outputs.{name}") });
            (name.clone(), out)
        })
        .collect();
    let segment = crate::util::to_local_id(&tool.id.replace('/', "-"));
    json!({
        "neuroflow": tool.value.get("neuroflow").cloned().unwrap_or(json!("0.1.0")),
        "kind": "workflow",
        "id": format!("neuroflow.mcp.adhoc/{segment}"),
        "version": tool.version,
        "description": format!("Single-step run of {}.", tool.id),
        "inputs": inputs,
        "steps": { step: { "tool": tool.id, "inputs": bindings } },
        "outputs": outputs
    })
}

/// Step ids in dependency order, using authorial order as the tie-breaker.
pub fn step_order(workflow: &Value) -> Result<Vec<String>, String> {
    let steps = workflow
        .get("steps")
        .and_then(Value::as_object)
        .ok_or("workflow has no steps object")?;
    let ids: Vec<String> = steps.keys().cloned().collect();
    let mut deps: HashMap<&str, HashSet<String>> = HashMap::new();
    for (id, step) in steps {
        let mut set = HashSet::new();
        for binding in step.get("inputs").and_then(Value::as_object).into_iter().flatten().map(|(_, b)| b) {
            if let Some(reference) = binding.get("ref").and_then(Value::as_str) {
                let parts: Vec<&str> = reference.split('.').collect();
                if parts.len() == 4 && parts[0] == "steps" {
                    set.insert(parts[1].to_string());
                }
            }
        }
        deps.insert(id, set);
    }
    let mut done: Vec<String> = Vec::new();
    while done.len() < ids.len() {
        let next = ids.iter().find(|id| {
            !done.contains(id) && deps[id.as_str()].iter().all(|d| done.contains(d) || !ids.contains(d))
        });
        match next {
            Some(id) => done.push(id.clone()),
            None => {
                let stuck: Vec<&str> = ids.iter().filter(|id| !done.contains(id)).map(String::as_str).collect();
                return Err(format!("dependency cycle among steps: {}", stuck.join(", ")));
            }
        }
    }
    Ok(done)
}

struct Paths {
    session: PathBuf,
    work: PathBuf,
}

/// Execute a workflow. `Err` means the run was rejected before any step launched.
/// Check the call's arguments against the workflow's declared inputs, apply
/// defaults, and resolve artifact references to canonical paths.
pub fn resolve_inputs(cfg: &Config, workflow: &Value, args: &Map<String, Value>) -> Result<Map<String, Value>, String> {
    let declared = workflow.get("inputs").and_then(Value::as_object).cloned().unwrap_or_default();
    for key in args.keys() {
        if !declared.contains_key(key) {
            let known: Vec<&str> = declared.keys().map(String::as_str).collect();
            return Err(format!("unknown input {key}; declared inputs: {}", known.join(", ")));
        }
    }
    let mut inputs = Map::new();
    for (name, decl) in &declared {
        let value = match args.get(name) {
            Some(v) if !v.is_null() => v.clone(),
            _ => match decl.get("default") {
                Some(d) => d.clone(),
                None if decl.get("optional").and_then(Value::as_bool).unwrap_or(false) => continue,
                None => return Err(format!("missing required input {name}")),
            },
        };
        let resolved = resolve_value(cfg, name, decl, &value, &[]).map_err(|e| format!("input {name}: {e}"))?;
        inputs.insert(name.clone(), resolved);
    }
    Ok(inputs)
}

/// Identity of a run's work: the workflow document, the documents of the tools
/// it references, and the resolved inputs, where every input path that exists
/// is replaced by its size and modification time (recursively for folders).
/// Two calls with the same fingerprint would do the same work, so the server
/// answers the second with the first run instead of executing again.
pub fn fingerprint(registry: &Registry, workflow: &Value, inputs: &Map<String, Value>) -> String {
    let mut tools = Map::new();
    for step in workflow.get("steps").and_then(Value::as_object).into_iter().flatten().map(|(_, s)| s) {
        if let Some(id) = step.get("tool").and_then(Value::as_str) {
            if let Some(doc) = registry.tool(id) {
                tools.insert(id.to_string(), doc.value.clone());
            }
        }
    }
    let stamped: Map<String, Value> = inputs.iter().map(|(k, v)| (k.clone(), stamp_paths(v))).collect();
    let text = canonical_json(&json!({ "workflow": workflow, "tools": tools, "inputs": stamped }));
    // FNV-1a, 64-bit: no dependency, stable across builds, ample for a session's runs.
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in text.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("fnv1a64-{hash:016x}-{}", text.len())
}

fn stamp_paths(v: &Value) -> Value {
    match v {
        Value::Array(items) => Value::Array(items.iter().map(stamp_paths).collect()),
        Value::String(s) if Path::new(s).is_absolute() && Path::new(s).exists() => {
            let path = Path::new(s);
            let stamp = |p: &Path| -> Value {
                let meta = fs::metadata(p).ok();
                let mtime = meta
                    .as_ref()
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_nanos() as u64);
                json!([meta.as_ref().map(|m| m.len()), mtime])
            };
            if path.is_dir() {
                let mut files = Vec::new();
                list_files(path, &mut files);
                files.sort();
                let entries: Map<String, Value> = files
                    .iter()
                    .map(|f| (f.strip_prefix(path).unwrap_or(f).to_string_lossy().into_owned(), stamp(f)))
                    .collect();
                json!({ "path": s, "files": entries })
            } else {
                json!({ "path": s, "file": stamp(path) })
            }
        }
        other => other.clone(),
    }
}

/// JSON with object keys sorted, so key order in a document does not matter.
fn canonical_json(v: &Value) -> String {
    match v {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let body: Vec<String> = keys
                .into_iter()
                .map(|k| format!("{}:{}", Value::String(k.clone()), canonical_json(&map[k])))
                .collect();
            format!("{{{}}}", body.join(","))
        }
        Value::Array(items) => format!("[{}]", items.iter().map(canonical_json).collect::<Vec<_>>().join(",")),
        other => other.to_string(),
    }
}

pub fn run_workflow(
    cfg: &Config,
    registry: &Registry,
    workflow: &Value,
    args: &Map<String, Value>,
    client: &Value,
    progress: Progress<'_>,
) -> Result<RunOutcome, String> {
    let cancelled = AtomicBool::new(false);
    run_workflow_with_cancel(cfg, registry, workflow, args, client, progress, &cancelled)
}

/// As `run_workflow`, but cooperatively terminates the current child process
/// when `cancelled` becomes true. Hosts own the flag and may set it from another
/// thread; the runtime still writes a complete cancelled session record.
pub fn run_workflow_with_cancel(
    cfg: &Config,
    registry: &Registry,
    workflow: &Value,
    args: &Map<String, Value>,
    client: &Value,
    progress: Progress<'_>,
    cancelled: &AtomicBool,
) -> Result<RunOutcome, String> {
    let report = neuroflow_core::validate_workflow_value_with_tools(workflow, Some(&registry.tools_array()));
    if let Some(issue) = report.issues.iter().find(|issue| issue.severity == "error") {
        return Err(format!("{}: {}", issue.path.as_deref().unwrap_or("workflow"), issue.message));
    }
    let order = step_order(workflow)?;
    registry.workflow_runnable(workflow)?;
    let wf_id = workflow.get("id").and_then(Value::as_str).unwrap_or("neuroflow.mcp.adhoc/workflow");
    let wf_version = workflow.get("version").and_then(Value::as_str).unwrap_or("0.0.0");

    // Resolve workflow inputs before creating anything on disk.
    let inputs = resolve_inputs(cfg, workflow, args)?;
    let fingerprint = fingerprint(registry, workflow, &inputs);

    let run_id = loop {
        let id = new_run_id();
        if !cfg.sessions_root.join(&id).exists() {
            break id;
        }
    };
    let session = cfg.sessions_root.join(&run_id);
    let paths = Paths { work: session.join("work"), session: session.clone() };
    fs::create_dir_all(&paths.work).map_err(|e| format!("cannot create session: {e}"))?;
    fs::create_dir_all(session.join("logs")).map_err(|e| e.to_string())?;
    write_json(&session.join("workflow.json"), workflow)?;

    let started_at = now_rfc3339();
    let mut context: Map<String, Value> = workflow
        .pointer("/context/fields")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .filter_map(|(k, d)| d.get("default").map(|v| (k.clone(), v.clone())))
        .collect();
    let mut record = json!({
        "runId": run_id,
        "status": "in-progress",
        "startedAt": started_at,
        "workflow": { "id": wf_id, "version": wf_version },
        "client": client,
        "inputs": inputs,
        "fingerprint": fingerprint,
        "steps": {}
    });
    let mut known_evidence: HashMap<String, Value> = HashMap::new();
    let mut initial_checks = Vec::new();
    let mut initial_failure = None;
    for (name, value) in &inputs {
        let decl = &workflow["inputs"][name];
        let t = decl["type"].as_str().unwrap_or("core:json");
        if !is_artifact_type(t, &[]) { continue; }
        let raw = args.get(name).unwrap_or(value);
        let checked = qualifiers::inspect(cfg, raw, value, &known_evidence).and_then(|evidence| {
            qualifiers::remember(&evidence, &mut known_evidence);
            qualifiers::enforce(&format!("inputs.{name}"), decl, &evidence, &mut initial_checks)
        });
        if let Err(error) = checked { initial_failure = Some(("inputs".to_string(), error)); break; }
    }
    if initial_failure.is_none() {
        for (name, value) in &mut context {
            // A `null` default is a placeholder an output mapping fills later;
            // `run_step` skips it the same way when a step reads the field.
            if value.is_null() { continue; }
            let decl = &workflow["context"]["fields"][name];
            let raw = value.clone();
            let checked = resolve_value(cfg, name, decl, value, &[]).and_then(|resolved| {
                *value = resolved;
                if is_artifact_type(decl["type"].as_str().unwrap_or("core:json"), &[]) {
                    let evidence = qualifiers::inspect(cfg, &raw, value, &known_evidence)?;
                    qualifiers::remember(&evidence, &mut known_evidence);
                    qualifiers::enforce(&format!("context.{name}"), decl, &evidence, &mut initial_checks)?;
                }
                Ok(())
            });
            if let Err(error) = checked { initial_failure = Some((format!("context.{name}"), error)); break; }
        }
    }
    record["qualifierChecks"] = json!(initial_checks);
    record["qualifierInspectors"] = qualifiers::capabilities();
    let mut step_outputs: HashMap<String, Map<String, Value>> = HashMap::new();
    let mut activities: Vec<StepRecord> = Vec::new();
    let mut failure: Option<(String, String)> = initial_failure;
    let total = order.len() as f64;

    let steps = workflow.get("steps").and_then(Value::as_object).cloned().unwrap_or_default();
    for (index, step_id) in order.iter().enumerate() {
        if failure.is_some() { break; }
        if cancelled.load(Ordering::SeqCst) {
            failure = Some((step_id.clone(), CANCELLED.into()));
            break;
        }
        let step = &steps[step_id];
        let tool_id = step.get("tool").and_then(Value::as_str).unwrap_or("");
        let tool = registry.tool(tool_id).ok_or_else(|| format!("tool {tool_id} disappeared"))?;
        progress(index as f64, total, &format!("step {}/{}: {step_id} ({tool_id})", index + 1, order.len()));

        let mut result = run_step(cfg, &paths, &run_id, workflow, step_id, step, tool, &inputs, &context, &step_outputs, &mut known_evidence, cancelled);
        if let Some(mappings) = step.get("outputMappings").and_then(Value::as_object).filter(|_| result.error.is_none()) {
            for (output, field) in mappings {
                if let (Some(field), Some(value)) = (field.as_str(), result.outputs.get(output)) {
                    let decl = &workflow["context"]["fields"][field];
                    if qualifiers::qualified(decl) {
                        let checked = qualifiers::inspect(cfg, value, value, &known_evidence).and_then(|evidence| {
                            qualifiers::enforce(&format!("steps.{step_id}.outputMappings.{output} -> context.{field}"),
                                decl, &evidence, &mut result.qualifier_checks)
                        });
                        if let Err(error) = checked {
                            result.error = Some(error);
                            result.status = "failed".into();
                            result.ended_at = now_rfc3339();
                            break;
                        }
                    }
                    context.insert(field.to_string(), value.clone());
                }
            }
        }
        let failed = result.error.clone();
        record["steps"][step_id] = json!({
            "tool": tool.id,
            "toolVersion": tool.version,
            "status": result.status,
            "exitCode": result.exit_code,
            "startedAt": result.started_at,
            "endedAt": result.ended_at,
            "inputs": result.inputs,
            "outputs": result.outputs,
            "types": result.types,
            "error": result.error,
            "qualifierChecks": result.qualifier_checks,
            "inputEvidence": result.input_evidence,
            "outputEvidence": result.output_evidence,
        });
        step_outputs.insert(step_id.clone(), result.outputs.clone());
        activities.push(result);
        write_json(&session.join("run.json"), &record)?;
        if let Some(err) = failed {
            failure = Some((step_id.clone(), err));
            break;
        }
    }
    progress(total, total, "done");

    // Public outputs.
    let mut public = Map::new();
    let mut public_refs = Map::new();
    if failure.is_none() {
        for (name, out) in workflow.get("outputs").and_then(Value::as_object).into_iter().flatten() {
            let reference = out.get("ref").and_then(Value::as_str).unwrap_or("");
            let parts: Vec<&str> = reference.split('.').collect();
            if let ["steps", s, "outputs", o] = parts.as_slice() {
                if let Some(v) = step_outputs.get(*s).and_then(|m| m.get(*o)) {
                    if qualifiers::qualified(out) {
                        let mut checks = Vec::new();
                        let checked = qualifiers::inspect(cfg, v, v, &known_evidence).and_then(|evidence| {
                            qualifiers::enforce(&format!("outputs.{name}"), out, &evidence, &mut checks)
                        });
                        record["outputQualifierChecks"][name] = json!(checks);
                        if let Err(error) = checked { failure = Some((format!("outputs.{name}"), error)); break; }
                    }
                    public.insert(name.clone(), v.clone());
                    public_refs.insert(name.clone(), json!({ "step": s, "output": o,
                        "type": out.get("type").cloned().unwrap_or(json!("core:json")) }));
                }
            }
        }
    }
    if failure.is_some() { public.clear(); public_refs.clear(); }
    let status = match &failure {
        Some((_, error)) if error == CANCELLED => "cancelled",
        Some(_) => "failed",
        None => "completed",
    };
    let ended_at = now_rfc3339();
    record["status"] = json!(status);
    record["endedAt"] = json!(ended_at);
    record["outputs"] = Value::Object(public_refs.clone());
    if let Some((step, err)) = &failure {
        record["failedStep"] = json!(step);
        record["error"] = json!(err);
    }
    write_json(&session.join("run.json"), &record)?;

    let prov = provenance(&record, &activities, workflow, client, &public_refs);
    write_json(&session.join("run.provenance.json"), &prov)?;

    // Structured result and links.
    let mut outputs = Map::new();
    let mut links = Vec::new();
    for (name, value) in &public {
        let r = &public_refs[name];
        let t = r["type"].as_str().unwrap_or("core:json");
        let step = r["step"].as_str().unwrap_or("");
        let output = r["output"].as_str().unwrap_or("");
        let value_types = registry
            .tool(steps[step].get("tool").and_then(Value::as_str).unwrap_or(""))
            .map(|d| value_types_of(&d.value))
            .unwrap_or_default();
        if is_artifact_type(t, &value_types) {
            let describe = |path: &str, uri: String| -> Value {
                let d = artifacts::descriptor(path, element_type(t), &uri);
                links.push((uri, name.to_string(), d["mediaType"].as_str().unwrap_or("").to_string(),
                            format!("{} output {name}", element_type(t))));
                d
            };
            let base = format!("neuroflow://runs/{run_id}/artifacts/{step}/{output}");
            let mut describe = describe;
            let v = match value {
                Value::Array(items) => Value::Array(
                    items
                        .iter()
                        .enumerate()
                        .map(|(i, p)| describe(p.as_str().unwrap_or(""), format!("{base}/{i}")))
                        .collect(),
                ),
                Value::String(p) => describe(p, base),
                other => other.clone(),
            };
            outputs.insert(name.clone(), v);
        } else {
            outputs.insert(name.clone(), value.clone());
        }
    }

    let mut structured = json!({
        "runId": run_id,
        "status": status,
        "outputs": outputs,
        "provenance": format!("neuroflow://runs/{run_id}/provenance"),
    });
    let mut summary = format!(
        "Run {run_id} {status}: {} of {} step(s) ran for {wf_id}.",
        activities.len(),
        order.len()
    );
    if let Some((step, err)) = &failure {
        structured["failedStep"] = json!(step);
        structured["error"] = json!(err);
        structured["logs"] = json!({
            "stdout": format!("neuroflow://runs/{run_id}/logs/{step}/stdout"),
            "stderr": format!("neuroflow://runs/{run_id}/logs/{step}/stderr"),
        });
        summary.push_str(&format!(
            " Step {step} failed: {err} Read neuroflow://runs/{run_id}/logs/{step}/stderr for details."
        ));
    } else {
        let names: Vec<&str> = outputs.keys().map(String::as_str).collect();
        summary.push_str(&format!(
            " Outputs: {}. Read an artifact URI for a summary (dimensions, labels, dataset layout).",
            if names.is_empty() { "none".to_string() } else { names.join(", ") }
        ));
    }
    Ok(RunOutcome { run_id, status: status.to_string(), structured, links, summary })
}

struct StepRecord {
    step_id: String,
    tool_id: String,
    tool_version: String,
    status: String,
    exit_code: Option<i32>,
    started_at: String,
    ended_at: String,
    inputs: Map<String, Value>,
    outputs: Map<String, Value>,
    types: Map<String, Value>,
    input_types: Map<String, Value>,
    error: Option<String>,
    qualifier_checks: Vec<Value>,
    input_evidence: Map<String, Value>,
    output_evidence: Map<String, Value>,
}

/// Start a step's process as the leader of its own process group so that
/// `terminate` can stop everything it forks: `bun tauri dev` starts cargo, the
/// app binary and a vite dev server; node adapters exec python3. Killing only
/// the direct child would orphan those and leave windows open and ports bound.
fn spawn_in_own_group(command: &mut Command) -> std::io::Result<Child> {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    command.spawn()
}

/// What a `uiApp` step with `completion: "outputsAvailable"` waits for: the
/// files or directories its declared outputs are delivered to. The step is done
/// when every required output exists, at least one output exists, and nothing
/// changed size or mtime between two polls at least `SETTLE` apart (the app may
/// still be writing). Outputs delivered through `result.json` watch that file.
struct OutputWatch {
    paths: Vec<(PathBuf, bool)>,
    seen: Option<Vec<Option<(u64, SystemTime)>>>,
    last_poll: Instant,
}

impl OutputWatch {
    const SETTLE: Duration = Duration::from_millis(250);

    fn new(tool: &Doc, out_dir: &Path, value_types: &[String]) -> Self {
        let default_mode = tool.value.pointer("/outputDelivery/default").and_then(Value::as_str).unwrap_or("core:result-file");
        let mut paths: Vec<(PathBuf, bool)> = Vec::new();
        for (name, decl) in tool.value.get("outputs").and_then(Value::as_object).into_iter().flatten() {
            let t = decl.get("type").and_then(Value::as_str).unwrap_or("core:json");
            let artifact = is_artifact_type(t, value_types);
            let required = !decl.get("optional").and_then(Value::as_bool).unwrap_or(false);
            let mode = decl.pointer("/delivery/mode").and_then(Value::as_str).unwrap_or(default_mode);
            let rel = decl.pointer("/delivery/path").and_then(Value::as_str);
            let path = match (mode, rel) {
                ("core:result-dir" | "core:result-file", Some(rel)) => out_dir.join(rel),
                ("core:result-dir", None) => out_dir.join(if artifact { name.clone() } else { format!("{name}.json") }),
                ("core:result-file", None) => out_dir.join("result.json"),
                _ => continue,
            };
            match paths.iter_mut().find(|(p, _)| *p == path) {
                Some((_, r)) => *r |= required,
                None => paths.push((path, required)),
            }
        }
        Self { paths, seen: None, last_poll: Instant::now() - Self::SETTLE }
    }

    fn ready(&mut self) -> bool {
        if self.paths.is_empty() || self.last_poll.elapsed() < Self::SETTLE {
            return false;
        }
        self.last_poll = Instant::now();
        let now: Vec<Option<(u64, SystemTime)>> = self
            .paths
            .iter()
            .map(|(p, _)| fs::metadata(p).ok().map(|m| (m.len(), m.modified().unwrap_or(UNIX_EPOCH))))
            .collect();
        let complete = now.iter().any(Option::is_some)
            && self.paths.iter().zip(&now).all(|((_, required), m)| !required || m.is_some());
        let stable = self.seen.as_ref() == Some(&now);
        self.seen = Some(now);
        complete && stable
    }
}

/// Stop a step started by `spawn_in_own_group` together with its descendants:
/// SIGTERM to the group so servers can release their ports, a short grace
/// period, then SIGKILL to whatever is left. Always reaps the direct child.
/// On non-Unix hosts only the direct child is killed (no job object yet).
fn terminate(child: &mut Child) {
    #[cfg(unix)]
    {
        let group = -(child.id() as i32);
        // SAFETY: plain signal delivery to a process group this process created.
        unsafe { libc::kill(group, libc::SIGTERM) };
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline && !matches!(child.try_wait(), Ok(Some(_))) {
            std::thread::sleep(Duration::from_millis(50));
        }
        unsafe { libc::kill(group, libc::SIGKILL) };
    }
    #[cfg(not(unix))]
    {
        let _ = child.kill();
    }
    let _ = child.wait();
}

#[allow(clippy::too_many_arguments)]
fn run_step(
    cfg: &Config,
    paths: &Paths,
    run_id: &str,
    workflow: &Value,
    step_id: &str,
    step: &Value,
    tool: &Doc,
    wf_inputs: &Map<String, Value>,
    context: &Map<String, Value>,
    step_outputs: &HashMap<String, Map<String, Value>>,
    known_evidence: &mut HashMap<String, Value>,
    cancelled: &AtomicBool,
) -> StepRecord {
    let started_at = now_rfc3339();
    let mut rec = StepRecord {
        step_id: step_id.to_string(),
        tool_id: tool.id.clone(),
        tool_version: tool.version.clone(),
        status: "failed".into(),
        exit_code: None,
        started_at: started_at.clone(),
        ended_at: started_at,
        inputs: Map::new(),
        outputs: Map::new(),
        types: Map::new(),
        input_types: Map::new(),
        error: None,
        qualifier_checks: Vec::new(),
        input_evidence: Map::new(),
        output_evidence: Map::new(),
    };
    let fail = |mut rec: StepRecord, msg: String| {
        rec.error = Some(msg);
        rec.ended_at = now_rfc3339();
        rec
    };

    // Bind tool inputs.
    let value_types = value_types_of(&tool.value);
    let tool_inputs = tool.value.get("inputs").and_then(Value::as_object).cloned().unwrap_or_default();
    let bindings = step.get("inputs").and_then(Value::as_object).cloned().unwrap_or_default();
    for (name, decl) in &tool_inputs {
        let bound = bindings.get(name).and_then(|b| {
            if let Some(c) = b.get("constant") {
                return Some(c.clone());
            }
            let reference = b.get("ref")?.as_str()?;
            let parts: Vec<&str> = reference.split('.').collect();
            match parts.as_slice() {
                ["inputs", n] => wf_inputs.get(*n).cloned(),
                ["context"] => Some(Value::Object(context.clone())),
                ["context", f] => context.get(*f).cloned(),
                ["steps", s, "outputs", o] => step_outputs.get(*s).and_then(|m| m.get(*o)).cloned(),
                _ => None,
            }
        });
        let value = match bound.or_else(|| decl.get("default").cloned()) {
            Some(v) if !v.is_null() => v,
            _ if decl.get("optional").and_then(Value::as_bool).unwrap_or(false) => continue,
            _ => return fail(rec, format!("required input {name} has no value")),
        };
        // Constants and upstream values are checked like caller input.
        match resolve_value(cfg, name, decl, &value, &value_types) {
            Ok(v) => {
                let t = decl["type"].as_str().unwrap_or("core:json");
                if is_artifact_type(t, &value_types) {
                    let evidence = match qualifiers::inspect(cfg, &value, &v, known_evidence) {
                        Ok(e) => e,
                        Err(e) => return fail(rec, format!("input {name}: {e}")),
                    };
                    rec.input_evidence.insert(name.clone(), evidence.clone());
                    if let Err(e) = qualifiers::enforce(&format!("steps.{step_id}.inputs.{name}"), decl, &evidence, &mut rec.qualifier_checks) {
                        return fail(rec, e);
                    }
                }
                rec.inputs.insert(name.clone(), v);
                rec.input_types.insert(name.clone(), decl.get("type").cloned().unwrap_or(json!("core:json")));
            }
            Err(e) => return fail(rec, format!("input {name}: {e}")),
        }
    }

    let launch = match launch_of(tool, &cfg.interpreters, cfg.interactive) {
        Ok(l) => l,
        Err(e) => return fail(rec, e),
    };
    let out_dir = paths.session.join("outputs").join(step_id);
    if let Err(e) = fs::create_dir_all(&out_dir) {
        return fail(rec, format!("cannot create output directory: {e}"));
    }
    let stage = step
        .get("stage")
        .and_then(Value::as_str)
        .or_else(|| tool.stage());
    let context_doc = json!({
        "neuroflow": "0.1.0",
        "kind": "neuroflow/session-context",
        "runId": run_id,
        "step": step_id,
        "tool": tool.id,
        "stage": stage,
        "workflow": { "id": workflow.get("id"), "version": workflow.get("version") },
        "inputs": rec.inputs,
        "outputDir": out_dir,
        "workDir": paths.work,
    });
    let _ = write_json(&paths.session.join("context.json"), &context_doc);
    let _ = write_json(&paths.session.join("logs").join(format!("{step_id}.context.json")), &context_doc);

    let stdout_path = paths.session.join("logs").join(format!("{step_id}.stdout"));
    let stderr_path = paths.session.join("logs").join(format!("{step_id}.stderr"));
    let (Ok(stdout), Ok(stderr)) = (fs::File::create(&stdout_path), fs::File::create(&stderr_path)) else {
        return fail(rec, "cannot create log files".into());
    };
    let output_mode = tool
        .value
        .pointer("/outputDelivery/default")
        .and_then(Value::as_str)
        .unwrap_or("core:result-file");
    let mut command = Command::new(&launch.interpreter);
    if let Some(script) = &launch.script {
        command.arg(script);
    }
    command
        .args(&launch.args)
        .current_dir(launch.cwd.as_deref().unwrap_or(&paths.work))
        .env("NEUROFLOW_SESSION", &paths.session)
        .env("NEUROFLOW_OUTPUT_DIR", &out_dir)
        .env("NEUROFLOW_OUTPUT_FILE", out_dir.join("result.json"))
        .env("NEUROFLOW_OUTPUT_MODE", output_mode)
        .env("NEUROFLOW_WORK_DIR", &paths.work)
        .env("NEUROFLOW_STEP", step_id)
        .env("NEUROFLOW_STEP_ID", step_id)
        .env("NEUROFLOW_RUN_ID", run_id)
        .env("NEUROFLOW_WORKFLOW_ID", workflow.get("id").and_then(Value::as_str).unwrap_or(""))
        .env("NEUROFLOW_WORKFLOW_VERSION", workflow.get("version").and_then(Value::as_str).unwrap_or(""))
        .envs(interpreter_env(&cfg.interpreters, &launch))
        .stdin(Stdio::null())
        .stdout(stdout)
        .stderr(stderr);
    let spawned = spawn_in_own_group(&mut command);
    let mut child = match spawned {
        Ok(c) => c,
        Err(e) => return fail(rec, format!("failed to start {}: {e}", launch.interpreter.display())),
    };
    // `completion` (session contract): "appClosed" (default) waits for the process
    // to exit; "outputsAvailable" finishes the step as soon as the declared outputs
    // are on disk and leaves the app open for the user to close.
    let completion = tool.value.pointer("/extensions/neuroflow~1launch/completion").and_then(Value::as_str).unwrap_or("appClosed");
    let mut output_watch = (completion == "outputsAvailable").then(|| OutputWatch::new(tool, &out_dir, &value_types));
    let started = Instant::now();
    let status: Option<ExitStatus> = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {
                if cancelled.load(Ordering::SeqCst) {
                    terminate(&mut child);
                    return fail(rec, CANCELLED.into());
                }
                if output_watch.as_mut().is_some_and(OutputWatch::ready) {
                    // Detached: the Child is dropped without a kill and the app stays open.
                    break None;
                }
                if let Some(limit) = cfg.step_timeout {
                    if started.elapsed() > limit {
                        terminate(&mut child);
                        return fail(rec, format!("timed out after {}s", limit.as_secs()));
                    }
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            Err(e) => return fail(rec, format!("wait failed: {e}")),
        }
    };
    rec.exit_code = status.and_then(|s| s.code());
    if let Some(status) = status {
        if !status.success() {
            let tail = tail_of(&stderr_path, 400);
            return fail(rec, format!("tool exited with status {}. {}", status.code().unwrap_or(-1), tail));
        }
    }

    match harvest(tool, &out_dir, &paths.work, &stdout_path, rec.exit_code.unwrap_or(0), &value_types) {
        Ok((mut outputs, types)) => {
            for (name, value) in &mut outputs {
                let decl = &tool.value["outputs"][name];
                match normalize_output(cfg, decl, value, &value_types) {
                    Ok(resolved) => *value = resolved,
                    Err(error) => return fail(rec, format!("output {name}: {error}")),
                }
            }
            for (name, value) in &outputs {
                let decl = &tool.value["outputs"][name];
                let t = decl["type"].as_str().unwrap_or("core:json");
                if !is_artifact_type(t, &value_types) { continue; }
                let mut evidence = match qualifiers::inspect(cfg, value, value, &HashMap::new()) {
                    Ok(e) => e,
                    Err(e) => return fail(rec, format!("output {name}: {e}")),
                };
                let producer = json!({ "run": run_id, "step": step_id, "output": name,
                    "tool": tool.id, "version": tool.version, "declaration": decl });
                qualifiers::produced(decl, &mut evidence, &rec.input_evidence, &producer);
                let requirements = qualifiers::output_requirements(decl, &rec.input_evidence);
                if let Err(e) = qualifiers::enforce_measured_output(&format!("steps.{step_id}.outputs.{name}"),
                    &requirements, &evidence, &mut rec.qualifier_checks) {
                    return fail(rec, e);
                }
                qualifiers::remember(&evidence, known_evidence);
                rec.output_evidence.insert(name.clone(), evidence);
            }
            rec.outputs = outputs;
            rec.types = types;
            rec.status = "completed".into();
            rec.ended_at = now_rfc3339();
            rec
        }
        Err(e) => fail(rec, e),
    }
}

/// Normalize what a tool delivered (RFC 0008) against its output declaration.
/// This is the delivery side, not the caller-input side: an array output may be
/// delivered as one path, an integer as a whole-valued number, and `enum`,
/// `min` and `max` are promises left to the consumer's own input check.
/// Artifact paths become canonical and must stay inside the data roots or the
/// sessions root; a scalar artifact output must be exactly one reference.
fn normalize_output(cfg: &Config, decl: &Value, value: &Value, value_types: &[String]) -> Result<Value, String> {
    let t = decl.get("type").and_then(Value::as_str).unwrap_or("core:json");
    if is_artifact_type(t, value_types) {
        let resolve = |v: &Value| -> Result<Value, String> {
            if !v.is_string() {
                return Err("expected an artifact reference string".into());
            }
            resolve_artifact(cfg, v).map(Value::String)
        };
        return match (is_array_type(t), value) {
            (true, Value::Array(items)) => items.iter().map(resolve).collect::<Result<Vec<_>, _>>().map(Value::Array),
            (true, single) => Ok(Value::Array(vec![resolve(single)?])),
            (false, Value::Array(items)) if items.len() == 1 => resolve(&items[0]),
            (false, Value::Array(_)) => Err("expected an artifact reference string".into()),
            (false, single) => resolve(single),
        };
    }
    let coerce = |v: &Value, t: &str| -> Result<Value, String> {
        match t {
            "core:string" if v.is_string() => Ok(v.clone()),
            "core:number" if v.is_number() => Ok(v.clone()),
            "core:integer" if v.is_i64() || v.is_u64() => Ok(v.clone()),
            "core:integer" if v.as_f64().is_some_and(|n| n.fract() == 0.0 && n.abs() < 9007199254740992.0) => {
                Ok(json!(v.as_f64().unwrap_or_default() as i64))
            }
            "core:boolean" if v.is_boolean() => Ok(v.clone()),
            "core:object" if v.is_object() => Ok(v.clone()),
            "core:string" | "core:number" | "core:integer" | "core:boolean" | "core:object" => {
                Err(format!("expected {t}, got {v}"))
            }
            _ => Ok(v.clone()),
        }
    };
    match neuroflow_core::array_element_type(t) {
        Some(inner) => match value {
            Value::Array(items) => items.iter().map(|i| coerce(i, inner)).collect::<Result<Vec<_>, _>>().map(Value::Array),
            single => Ok(Value::Array(vec![coerce(single, inner)?])),
        },
        None => coerce(value, t),
    }
}

/// Check and normalize one value against its declaration. Artifact references
/// become canonical absolute paths confined to the data roots or the sessions root.
fn resolve_value(cfg: &Config, name: &str, decl: &Value, value: &Value, value_types: &[String]) -> Result<Value, String> {
    let t = decl.get("type").and_then(Value::as_str).unwrap_or("core:json");
    if is_artifact_type(t, value_types) {
        let resolve = |value: &Value| -> Result<String, String> {
            if let Some(uri) = value.as_str().filter(|v| v.starts_with("neuroflow://")) {
                let source_type = artifacts::artifact_type(cfg, uri)?;
                if !neuroflow_core::is_type_compatible(&source_type, element_type(t)) {
                    return Err(format!("artifact type {source_type} is incompatible with {}", element_type(t)));
                }
            }
            resolve_artifact(cfg, value)
        };
        if is_array_type(t) {
            let items = value.as_array().ok_or("expected an array of artifact references")?;
            let resolved: Result<Vec<Value>, String> =
                items.iter().map(|v| resolve(v).map(Value::String)).collect();
            return resolved.map(Value::Array);
        }
        return resolve(value).map(Value::String);
    }
    let check = |v: &Value, t: &str| -> Result<(), String> {
        let ok = match t {
            "core:string" => v.is_string(),
            "core:number" => v.is_number(),
            "core:integer" => v.is_i64() || v.is_u64(),
            "core:boolean" => v.is_boolean(),
            "core:object" => v.is_object(),
            _ => true,
        };
        if ok { Ok(()) } else { Err(format!("expected {t}, got {v}")) }
    };
    match neuroflow_core::array_element_type(t) {
        Some(inner) => {
            let items = value.as_array().ok_or_else(|| format!("expected {t}"))?;
            for item in items {
                check(item, inner)?;
            }
        }
        None => check(value, t)?,
    }
    if let Some(options) = decl.get("enum").and_then(Value::as_array) {
        if !options.contains(value) {
            return Err(format!("{value} is not one of {}", Value::Array(options.clone())));
        }
    }
    if let (Some(n), Some(min)) = (value.as_f64(), decl.get("min").and_then(Value::as_f64)) {
        if n < min {
            return Err(format!("{name} must be >= {min}"));
        }
    }
    if let (Some(n), Some(max)) = (value.as_f64(), decl.get("max").and_then(Value::as_f64)) {
        if n > max {
            return Err(format!("{name} must be <= {max}"));
        }
    }
    Ok(value.clone())
}

pub fn resolve_artifact(cfg: &Config, value: &Value) -> Result<String, String> {
    let raw = value.as_str().ok_or("expected an artifact reference string")?;
    let path = if raw.starts_with("neuroflow://") {
        artifacts::resolve_artifact_uri(cfg, raw)?
    } else {
        let p = Path::new(raw);
        if !p.is_absolute() {
            return Err(format!("{raw} is not an absolute path or neuroflow:// URI"));
        }
        p.to_path_buf()
    };
    let canonical = path
        .canonicalize()
        .map_err(|_| format!("{} does not exist", path.display()))?;
    let mut roots = cfg.data_roots.clone();
    roots.push(cfg.sessions_root.clone());
    if !within_any(&canonical, &roots) {
        return Err(format!(
            "{} is outside the allowed data roots ({}). Start the server with --data-root to allow it.",
            canonical.display(),
            cfg.data_roots.iter().map(|r| r.display().to_string()).collect::<Vec<_>>().join(", ")
        ));
    }
    Ok(canonical.to_string_lossy().into_owned())
}

type Harvested = (Map<String, Value>, Map<String, Value>);

/// Collect declared outputs from where the tool's delivery mode says they live (RFC 0008).
fn harvest(
    tool: &Doc,
    out_dir: &Path,
    work_dir: &Path,
    stdout_path: &Path,
    exit_code: i32,
    value_types: &[String],
) -> Result<Harvested, String> {
    let mut outputs = Map::new();
    let mut types = Map::new();
    let default_mode = tool
        .value
        .pointer("/outputDelivery/default")
        .and_then(Value::as_str)
        .unwrap_or("core:result-file");
    let mut result_file: Option<Value> = None;
    let mut stdout_json: Option<Value> = None;

    for (name, decl) in tool.value.get("outputs").and_then(Value::as_object).into_iter().flatten() {
        let t = decl.get("type").and_then(Value::as_str).unwrap_or("core:json");
        let artifact = is_artifact_type(t, value_types);
        let optional = decl.get("optional").and_then(Value::as_bool).unwrap_or(false);
        let mode = decl.pointer("/delivery/mode").and_then(Value::as_str).unwrap_or(default_mode);
        let rel = decl.pointer("/delivery/path").and_then(Value::as_str);

        let value: Option<Value> = match mode {
            "core:result-dir" | "core:result-file" if rel.is_some() || mode == "core:result-dir" => {
                let rel = rel.map(str::to_string).unwrap_or_else(|| {
                    if artifact { name.clone() } else { format!("{name}.json") }
                });
                from_path(&out_dir.join(rel), t, artifact)?
            }
            "core:result-file" => {
                if result_file.is_none() {
                    let p = out_dir.join("result.json");
                    result_file = Some(if p.is_file() {
                        serde_json::from_str(&fs::read_to_string(&p).map_err(|e| e.to_string())?)
                            .map_err(|e| format!("result.json is not valid JSON: {e}"))?
                    } else {
                        json!({})
                    });
                }
                let v = result_file.as_ref().and_then(|r| r.get(name)).cloned();
                match (v, artifact) {
                    (Some(v), true) => Some(absolutize(&v, out_dir)),
                    (v, _) => v,
                }
            }
            "core:stdout-json" => {
                if stdout_json.is_none() {
                    let text = fs::read_to_string(stdout_path).unwrap_or_default();
                    stdout_json = text
                        .lines()
                        .rev()
                        .find_map(|l| serde_json::from_str::<Value>(l.trim()).ok().filter(Value::is_object))
                        .or(Some(json!({})));
                }
                stdout_json.as_ref().and_then(|r| r.get(name)).cloned()
            }
            "core:exit-code" => Some(json!(exit_code)),
            "core:fixed-path" => {
                let rel = rel.ok_or_else(|| format!("output {name}: core:fixed-path needs delivery.path"))?;
                from_path(&work_dir.join(rel), t, artifact)?
            }
            other => return Err(format!("output {name}: delivery mode {other} is not supported by this server yet")),
        };
        match value {
            Some(v) => {
                outputs.insert(name.clone(), v);
                types.insert(name.clone(), json!(t));
            }
            None if optional => {}
            None => return Err(format!("required output {name} was not produced")),
        }
    }
    Ok((outputs, types))
}

fn from_path(path: &Path, t: &str, artifact: bool) -> Result<Option<Value>, String> {
    if !path.exists() {
        return Ok(None);
    }
    if !artifact {
        let text = fs::read_to_string(path).map_err(|e| e.to_string())?;
        return serde_json::from_str(&text)
            .map(Some)
            .map_err(|e| format!("{} is not valid JSON: {e}", path.display()));
    }
    let canonical = path.canonicalize().map_err(|e| e.to_string())?;
    if is_array_type(t) {
        if canonical.is_dir() && !is_directory_type(element_type(t)) {
            let mut files = Vec::new();
            list_files(&canonical, &mut files);
            files.sort();
            return Ok(Some(Value::Array(
                files.into_iter().map(|f| Value::String(f.to_string_lossy().into_owned())).collect(),
            )));
        }
        return Ok(Some(json!([canonical.to_string_lossy()])));
    }
    Ok(Some(Value::String(canonical.to_string_lossy().into_owned())))
}

fn absolutize(v: &Value, base: &Path) -> Value {
    match v {
        Value::String(s) if !Path::new(s).is_absolute() => Value::String(base.join(s).to_string_lossy().into_owned()),
        Value::Array(items) => Value::Array(items.iter().map(|i| absolutize(i, base)).collect()),
        other => other.clone(),
    }
}

fn list_files(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(dir).into_iter().flatten().flatten() {
        let path = entry.path();
        if entry.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        if path.is_dir() {
            list_files(&path, out);
        } else {
            out.push(path);
        }
    }
}

fn tail_of(path: &Path, max: usize) -> String {
    let text = fs::read_to_string(path).unwrap_or_default();
    let text = text.trim();
    if text.is_empty() {
        return String::new();
    }
    let start = text.len().saturating_sub(max);
    let start = (start..text.len()).find(|&i| text.is_char_boundary(i)).unwrap_or(0);
    format!("stderr (tail): {}", &text[start..])
}

pub fn write_json(path: &Path, value: &Value) -> Result<(), String> {
    let text = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    fs::write(path, text + "\n").map_err(|e| format!("cannot write {}: {e}", path.display()))
}

/// Build a provenance document (spec section 17) for a finished run.
#[allow(clippy::type_complexity)]
fn provenance(record: &Value, steps: &[StepRecord], workflow: &Value, client: &Value, public: &Map<String, Value>) -> Value {
    let run_id = record["runId"].as_str().unwrap_or("run");
    let mut agents = vec![json!({
        "id": "agent-runtime", "type": "software", "name": "neuroflow-mcp",
        "version": env!("CARGO_PKG_VERSION"), "role": "runtime"
    })];
    if let Some(name) = client.get("name").and_then(Value::as_str) {
        let mut a = json!({ "id": "agent-mcp-client", "type": "software", "name": name, "role": "mcp-client" });
        if let Some(v) = client.get("version").and_then(Value::as_str) {
            a["version"] = json!(v);
        }
        agents.push(a);
    }
    let mut entities: Vec<Value> = Vec::new();
    let mut by_path: HashMap<String, String> = HashMap::new();
    let mut entity = |entities: &mut Vec<Value>, path_or_value: &Value, t: &str, role: &str, artifact: bool| -> String {
        if artifact {
            if let Some(p) = path_or_value.as_str() {
                if let Some(id) = by_path.get(p) {
                    return id.clone();
                }
            }
        }
        let id = format!("ent-{}", entities.len() + 1);
        let mut e = json!({ "id": id, "type": t, "role": role });
        if artifact {
            let p = path_or_value.as_str().unwrap_or("");
            e["path"] = json!(p);
            if let Ok(meta) = fs::metadata(p) {
                if meta.is_file() {
                    e["size"] = json!(meta.len());
                }
            }
            by_path.insert(p.to_string(), id.clone());
        } else {
            e["value"] = path_or_value.clone();
        }
        entities.push(e);
        id
    };
    let add_all = |entities: &mut Vec<Value>, v: &Value, t: &str, role: &str, entity: &mut dyn FnMut(&mut Vec<Value>, &Value, &str, &str, bool) -> String| -> Vec<(Option<usize>, String)> {
        let artifact = is_artifact_type(t, &[]);
        match (v, artifact && is_array_type(t)) {
            (Value::Array(items), true) => items
                .iter()
                .enumerate()
                .map(|(i, item)| (Some(i), entity(entities, item, element_type(t), role, true)))
                .collect(),
            _ => vec![(None, entity(entities, v, t, role, artifact))],
        }
    };

    let mut inputs_map = Map::new();
    let decls = workflow.get("inputs").and_then(Value::as_object).cloned().unwrap_or_default();
    for (name, v) in record["inputs"].as_object().into_iter().flatten() {
        let t = decls.get(name).and_then(|d| d.get("type")).and_then(Value::as_str).unwrap_or("core:json");
        for (i, id) in add_all(&mut entities, v, t, "workflow-input", &mut entity) {
            let key = i.map(|i| format!("{name}.{i}")).unwrap_or_else(|| name.clone());
            inputs_map.insert(key, json!(id));
        }
    }

    let mut activities = Vec::new();
    let mut output_ids: HashMap<(String, String), Vec<(Option<usize>, String)>> = HashMap::new();
    for (n, step) in steps.iter().enumerate() {
        let mut used = Vec::new();
        for (name, v) in &step.inputs {
            let t = step.input_types.get(name).and_then(Value::as_str).unwrap_or("core:json");
            if is_artifact_type(t, &[]) {
                used.extend(add_all(&mut entities, v, t, "step-input", &mut entity).into_iter().map(|(_, id)| json!(id)));
            }
        }
        let mut generated = Vec::new();
        for (name, v) in &step.outputs {
            let t = step.types.get(name).and_then(Value::as_str).unwrap_or("core:json");
            let ids = add_all(&mut entities, v, t, "step-output", &mut entity);
            generated.extend(ids.iter().map(|(_, id)| json!(id)));
            output_ids.insert((step.step_id.clone(), name.clone()), ids);
        }
        let agent_id = format!("agent-tool-{}", n + 1);
        agents.push(json!({ "id": agent_id, "type": "software", "name": step.tool_id, "version": step.tool_version, "role": "tool" }));
        let mut act = json!({
            "id": format!("act-{}", n + 1),
            "stepId": step.step_id,
            "toolId": step.tool_id,
            "agent": agent_id,
            "startedAt": step.started_at,
            "endedAt": step.ended_at,
            "status": step.status,
        });
        if valid_semver(&step.tool_version) {
            act["toolVersion"] = json!(step.tool_version);
        }
        if !used.is_empty() {
            act["used"] = Value::Array(used);
        }
        if !generated.is_empty() {
            act["generated"] = Value::Array(generated);
        }
        if let Some(code) = step.exit_code {
            act["exitCode"] = json!(code);
        }
        if let Some(err) = &step.error {
            act["error"] = json!(err);
        }
        activities.push(act);
    }

    let mut outputs_map = Map::new();
    for (name, r) in public {
        let key = (r["step"].as_str().unwrap_or("").to_string(), r["output"].as_str().unwrap_or("").to_string());
        for (i, id) in output_ids.get(&key).cloned().unwrap_or_default() {
            let k = i.map(|i| format!("{name}.{i}")).unwrap_or_else(|| name.clone());
            outputs_map.insert(k, json!(id));
        }
    }

    let status = record["status"].as_str().unwrap_or("failed");
    let mut run = json!({
        "runId": run_id,
        "startedAt": record["startedAt"],
        "endedAt": record["endedAt"],
        "status": status,
        "host": { "platform": std::env::consts::OS, "arch": std::env::consts::ARCH }
    });
    if let Some(step) = record.get("failedStep").and_then(Value::as_str) {
        run["haltedAtStep"] = json!(step);
    }
    let wf_id = record.pointer("/workflow/id").and_then(Value::as_str).unwrap_or("neuroflow.mcp.adhoc/workflow");
    let wf_version = record.pointer("/workflow/version").and_then(Value::as_str).unwrap_or("0.0.0");
    json!({
        "neuroflow": "0.1.0",
        "kind": "provenance",
        "id": format!("neuroflow.runs/{run_id}"),
        "version": "1.0.0",
        "description": format!("Provenance for run {run_id} executed by neuroflow-mcp."),
        "run": run,
        "workflow": { "id": wf_id, "version": if valid_semver(wf_version) { wf_version } else { "0.0.0" } },
        "agents": agents,
        "activities": activities,
        "entities": entities,
        "inputs": inputs_map,
        "outputs": outputs_map,
        "extensions": { "neuroflow/qualifiers": {
            "inspectors": record["qualifierInspectors"],
            "inputChecks": record["qualifierChecks"],
            "outputChecks": record["outputQualifierChecks"],
            "steps": steps.iter().map(|step| json!({ "step": step.step_id,
                "checks": step.qualifier_checks, "inputs": step.input_evidence,
                "outputs": step.output_evidence })).collect::<Vec<_>>()
        } },
    })
}

fn valid_semver(v: &str) -> bool {
    let parts: Vec<&str> = v.split('.').collect();
    parts.len() == 3 && parts.iter().all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn orders_steps_by_dependency() {
        let wf = json!({ "steps": {
            "qa": { "tool": "t/qa", "inputs": { "v": { "ref": "steps.filter.outputs.out" } } },
            "filter": { "tool": "t/f", "inputs": { "d": { "ref": "inputs.d" } } }
        }});
        assert_eq!(step_order(&wf).unwrap(), vec!["filter", "qa"]);
    }

    #[cfg(unix)]
    #[test]
    fn terminate_stops_the_whole_process_tree() {
        // sh forks a grandchild and records its pid; killing only sh would leave it running.
        let dir = std::env::temp_dir().join(format!("neuroflow-pg-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let pidfile = dir.join("grandchild.pid");
        let mut command = Command::new("sh");
        command.arg("-c").arg(format!("sleep 60 & echo $! > '{}'; wait", pidfile.display()));
        let mut child = spawn_in_own_group(&mut command).unwrap();
        let grandchild = loop {
            if let Some(pid) = fs::read_to_string(&pidfile).ok().and_then(|t| t.trim().parse::<i32>().ok()) {
                break pid;
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        terminate(&mut child);
        // A dead grandchild is reparented and reaped by init; kill(pid, 0) then fails with ESRCH.
        let deadline = Instant::now() + Duration::from_secs(2);
        let gone = loop {
            if unsafe { libc::kill(grandchild, 0) } != 0 { break true; }
            if Instant::now() > deadline { break false; }
            std::thread::sleep(Duration::from_millis(20));
        };
        let _ = fs::remove_dir_all(&dir);
        assert!(gone, "grandchild {grandchild} survived terminate");
    }

    #[cfg(unix)]
    #[test]
    fn outputs_available_completes_the_step_while_the_app_keeps_running() {
        let root = std::env::temp_dir().join(format!("neuroflow-uiapp-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("registry")).unwrap();
        fs::create_dir_all(root.join("runs")).unwrap();
        fs::create_dir_all(root.join("checkout")).unwrap();
        let root = fs::canonicalize(&root).unwrap();
        let app = format!("watch-test-{}", std::process::id());
        std::env::set_var(format!("NEUROFLOW_UI_APP_{}", app.to_uppercase().replace('-', "_")), root.join("checkout"));
        // The "app" saves its state at once, then stays open for a while.
        let tool = json!({
            "neuroflow": "0.1.1", "kind": "tool", "id": "test/viewer", "version": "1.0.0",
            "description": "Fake interactive viewer.",
            "inputs": {},
            "outputs": { "review_state": { "type": "core:json", "description": "Viewer state.",
                "delivery": { "mode": "core:result-file", "path": "review.state.json" } } },
            "extensions": { "neuroflow/launch": {
                "kind": "uiApp", "app": app, "command": "sh", "interactive": true, "completion": "outputsAvailable",
                "args": ["-c", "echo '{\"saved\": true}' > \"$NEUROFLOW_OUTPUT_DIR/review.state.json\"; sleep 4"]
            } }
        });
        fs::write(root.join("registry/viewer.json"), tool.to_string()).unwrap();
        let cfg = Config {
            registry_dirs: vec![root.join("registry")], spec_dir: None, data_roots: vec![root.clone()],
            sessions_root: root.join("runs"), interpreters: HashMap::new(), step_timeout: None,
            summary_max_bytes: 1024, interactive: true,
        };
        let registry = Registry::load(&cfg.registry_dirs, &cfg.interpreters, cfg.interactive).unwrap();
        let doc = registry.tool("test/viewer").unwrap();
        assert_eq!(doc.runnable, Ok(()), "{:?}", doc.runnable);
        let workflow = wrap_tool(doc);
        let started = Instant::now();
        let outcome = run_workflow(&cfg, &registry, &workflow, &Map::new(), &json!({}), &mut |_, _, _| {}).unwrap();
        let elapsed = started.elapsed();
        let _ = fs::remove_dir_all(&root);
        assert_eq!(outcome.status, "completed", "{}", outcome.summary);
        assert!(elapsed < Duration::from_secs(3), "step waited for the app to exit: {elapsed:?}");
        assert_eq!(outcome.structured["outputs"]["review_state"]["saved"], json!(true), "{}", outcome.structured);
    }

    #[test]
    fn fingerprint_ignores_key_order_and_tracks_input_files() {
        let registry = Registry::load(&[], &HashMap::new(), false).unwrap();
        let a = json!({ "id": "x", "steps": { "s": { "tool": "t/a", "inputs": {} } }, "inputs": {} });
        let b = json!({ "inputs": {}, "steps": { "s": { "inputs": {}, "tool": "t/a" } }, "id": "x" });
        let mut inputs = Map::new();
        inputs.insert("n".into(), json!(1));
        let same = fingerprint(&registry, &a, &inputs);
        assert_eq!(same, fingerprint(&registry, &b, &inputs), "key order does not matter");
        inputs.insert("n".into(), json!(2));
        assert_ne!(same, fingerprint(&registry, &a, &inputs), "a changed input value changes the fingerprint");

        let dir = std::env::temp_dir().join(format!("neuroflow-fp-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("in.txt");
        fs::write(&file, "one").unwrap();
        inputs.insert("f".into(), json!(file.to_string_lossy()));
        let before = fingerprint(&registry, &a, &inputs);
        assert_eq!(before, fingerprint(&registry, &a, &inputs));
        fs::write(&file, "three").unwrap();
        assert_ne!(before, fingerprint(&registry, &a, &inputs), "changed input file changes the fingerprint");
        inputs.insert("f".into(), json!(dir.to_string_lossy()));
        let folder = fingerprint(&registry, &a, &inputs);
        fs::write(dir.join("more.txt"), "x").unwrap();
        assert_ne!(folder, fingerprint(&registry, &a, &inputs), "new file in an input folder changes the fingerprint");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn rejects_cycles() {
        let wf = json!({ "steps": {
            "a": { "tool": "t/a", "inputs": { "x": { "ref": "steps.b.outputs.y" } } },
            "b": { "tool": "t/b", "inputs": { "x": { "ref": "steps.a.outputs.y" } } }
        }});
        assert!(step_order(&wf).unwrap_err().contains("cycle"));
    }
}
