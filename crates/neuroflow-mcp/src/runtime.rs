//! Minimal NeuroFlow runtime: resolves inputs, runs `script` tools under the
//! file-based session contract (docs/neuroflow-session-contract.md), harvests
//! outputs per RFC 0008, and writes a provenance document (RFC 0003).

use crate::artifacts;
use crate::registry::{launch_of, Doc, Registry};
use crate::schema::{element_type, is_array_type, is_artifact_type, is_directory_type, value_types_of};
use crate::util::{new_run_id, now_rfc3339, to_local_id, within_any};
use crate::Config;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Instant;

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
        "neuroflow": "0.1.0",
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
    let mut step_outputs: HashMap<String, Map<String, Value>> = HashMap::new();
    let mut activities: Vec<StepRecord> = Vec::new();
    let mut failure: Option<(String, String)> = None;
    let total = order.len() as f64;

    let steps = workflow.get("steps").and_then(Value::as_object).cloned().unwrap_or_default();
    for (index, step_id) in order.iter().enumerate() {
        let step = &steps[step_id];
        let tool_id = step.get("tool").and_then(Value::as_str).unwrap_or("");
        let tool = registry.tool(tool_id).ok_or_else(|| format!("tool {tool_id} disappeared"))?;
        progress(index as f64, total, &format!("step {}/{}: {step_id} ({tool_id})", index + 1, order.len()));

        let result = run_step(cfg, &paths, &run_id, workflow, step_id, step, tool, &inputs, &context, &step_outputs);
        let failed = result.error.clone();
        if let Some(mappings) = step.get("outputMappings").and_then(Value::as_object) {
            for (output, field) in mappings {
                if let (Some(field), Some(value)) = (field.as_str(), result.outputs.get(output)) {
                    context.insert(field.to_string(), value.clone());
                }
            }
        }
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
                    public.insert(name.clone(), v.clone());
                    public_refs.insert(name.clone(), json!({ "step": s, "output": o,
                        "type": out.get("type").cloned().unwrap_or(json!("core:json")) }));
                }
            }
        }
    }
    let status = if failure.is_some() { "failed" } else { "completed" };
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
                rec.inputs.insert(name.clone(), v);
                rec.input_types.insert(name.clone(), decl.get("type").cloned().unwrap_or(json!("core:json")));
            }
            Err(e) => return fail(rec, format!("input {name}: {e}")),
        }
    }

    let launch = match launch_of(tool, &cfg.interpreters) {
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
    let spawned = Command::new(&launch.interpreter)
        .arg(&launch.script)
        .current_dir(&paths.work)
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
        .stdin(Stdio::null())
        .stdout(stdout)
        .stderr(stderr)
        .spawn();
    let mut child = match spawned {
        Ok(c) => c,
        Err(e) => return fail(rec, format!("failed to start {}: {e}", launch.interpreter.display())),
    };
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if let Some(limit) = cfg.step_timeout {
                    if started.elapsed() > limit {
                        let _ = child.kill();
                        let _ = child.wait();
                        return fail(rec, format!("timed out after {}s", limit.as_secs()));
                    }
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            Err(e) => return fail(rec, format!("wait failed: {e}")),
        }
    };
    rec.exit_code = status.code();
    if !status.success() {
        let tail = tail_of(&stderr_path, 400);
        return fail(rec, format!("tool exited with status {}. {}", status.code().unwrap_or(-1), tail));
    }

    match harvest(tool, &out_dir, &paths.work, &stdout_path, status.code().unwrap_or(0), &value_types) {
        Ok((outputs, types)) => {
            rec.outputs = outputs;
            rec.types = types;
            rec.status = "completed".into();
            rec.ended_at = now_rfc3339();
            rec
        }
        Err(e) => fail(rec, e),
    }
}

/// Check and normalize one value against its declaration. Artifact references
/// become canonical absolute paths confined to the data roots or the sessions root.
fn resolve_value(cfg: &Config, name: &str, decl: &Value, value: &Value, value_types: &[String]) -> Result<Value, String> {
    let t = decl.get("type").and_then(Value::as_str).unwrap_or("core:json");
    if is_artifact_type(t, value_types) {
        if is_array_type(t) {
            let items = value.as_array().ok_or("expected an array of artifact references")?;
            let resolved: Result<Vec<Value>, String> =
                items.iter().map(|v| resolve_artifact(cfg, v).map(Value::String)).collect();
            return resolved.map(Value::Array);
        }
        return resolve_artifact(cfg, value).map(Value::String);
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

    #[test]
    fn fingerprint_ignores_key_order_and_tracks_input_files() {
        let registry = Registry::load(&[], &HashMap::new()).unwrap();
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
