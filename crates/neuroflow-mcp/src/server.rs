//! MCP over stdio: JSON-RPC dispatch, the fixed binding tools, and the tools
//! generated from registry documents (RFC 0009 sections 1 to 3).

use crate::{artifacts, qualifiers};
use crate::registry::{Kind, Registry};
use crate::runtime::{self, step_order};
use crate::schema::{element_type, input_schema, run_output_schema, value_types_of};
use crate::Config;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::io::{BufRead, Write};

/// Protocol revisions this server implements, newest first. 2026-07-28
/// (stateless requests, MRTR, tasks extension) is not implemented yet.
const SUPPORTED_VERSIONS: &[&str] = &["2025-11-25", "2025-06-18", "2025-03-26"];

pub struct Server {
    cfg: Config,
    registry: Registry,
    version: String,
    client: Value,
    /// Completed runs of this session by work fingerprint (runtime::fingerprint):
    /// a repeated call with identical workflow and inputs is answered from here
    /// instead of executing (and writing its outputs) a second time.
    completed: HashMap<String, (String, Value)>,
}

impl Server {
    pub fn new(cfg: Config, registry: Registry) -> Self {
        Server { cfg, registry, version: SUPPORTED_VERSIONS[0].to_string(), client: json!({}), completed: HashMap::new() }
    }

    /// Features added in 2025-06-18: titles, structuredContent, outputSchema, resource links.
    fn modern(&self) -> bool {
        self.version.as_str() >= "2025-06-18"
    }

    pub fn serve(&mut self) {
        let stdin = std::io::stdin();
        for line in stdin.lock().lines() {
            let Ok(line) = line else { break };
            if line.trim().is_empty() {
                continue;
            }
            let msg: Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(e) => {
                    send(&json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": format!("parse error: {e}") } }));
                    continue;
                }
            };
            if let Some(batch) = msg.as_array() {
                for m in batch {
                    self.handle(m);
                }
            } else {
                self.handle(&msg);
            }
        }
    }

    fn handle(&mut self, msg: &Value) {
        let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
        let Some(id) = msg.get("id").cloned() else {
            return; // notification
        };
        if method.is_empty() {
            return; // a response to something we never send
        }
        let params = msg.get("params").cloned().unwrap_or(json!({}));
        if let Some(info) = params.pointer("/_meta/io.modelcontextprotocol~1clientInfo") {
            self.client = info.clone();
        }
        let result = match method {
            "initialize" => Ok(self.initialize(&params)),
            "server/discover" => Ok(json!({
                "supportedVersions": SUPPORTED_VERSIONS,
                "capabilities": self.capabilities(),
                "serverInfo": server_info(),
            })),
            "ping" => Ok(json!({})),
            "tools/list" => Ok(json!({ "tools": self.list_tools() })),
            "tools/call" => self.call_tool(&params),
            "resources/list" => Ok(json!({ "resources": artifacts::list(&self.cfg, &self.registry) })),
            "resources/templates/list" => Ok(json!({ "resourceTemplates": artifacts::templates() })),
            "resources/read" => {
                let uri = params.get("uri").and_then(Value::as_str).unwrap_or("");
                artifacts::read(&self.cfg, &self.registry, uri)
                    .map(|contents| json!({ "contents": contents }))
                    .map_err(|e| (-32602, e))
            }
            "prompts/list" => Ok(json!({ "prompts": [{
                "name": "neuroflow_author_workflow",
                "title": "Author a NeuroFlow workflow",
                "description": "The NeuroFlow workflow model, reference grammar, and the tools this server can run, for composing a new pipeline.",
                "arguments": [{ "name": "goal", "description": "What the pipeline should do.", "required": false }]
            }]})),
            "prompts/get" => self.get_prompt(&params),
            "logging/setLevel" => Ok(json!({})),
            _ => Err((-32601, format!("method not found: {method}"))),
        };
        match result {
            Ok(result) => send(&json!({ "jsonrpc": "2.0", "id": id, "result": result })),
            Err((code, message)) => send(&json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })),
        }
    }

    fn capabilities(&self) -> Value {
        json!({
            "tools": { "listChanged": false },
            "resources": { "listChanged": false },
            "prompts": { "listChanged": false },
            "experimental": {
                "com.niivue/neuroflow": {
                    "neuroflow": "0.1.1",
                    "supportedNeuroflowVersions": ["0.1.0", "0.1.1"],
                    "binding": "0009",
                    "features": ["summaries", "type-qualifier-enforcement"],
                    "qualifierInspectors": qualifiers::capabilities(),
                    "agentApprovals": false
                }
            }
        })
    }

    fn initialize(&mut self, params: &Value) -> Value {
        let requested = params.get("protocolVersion").and_then(Value::as_str).unwrap_or("");
        self.version = if SUPPORTED_VERSIONS.contains(&requested) {
            requested.to_string()
        } else {
            SUPPORTED_VERSIONS[0].to_string()
        };
        if let Some(info) = params.get("clientInfo") {
            self.client = info.clone();
        }
        let runnable = self.registry.docs.iter().filter(|d| d.mcp_name.is_some()).count();
        json!({
            "protocolVersion": self.version,
            "capabilities": self.capabilities(),
            "serverInfo": server_info(),
            "instructions": format!(
                "NeuroFlow runs typed neuroimaging tools and workflows ({runnable} runnable here). \
                 Discover with neuroflow_list (filter by acceptsType/producesType to chain tools). \
                 To build a pipeline: write a NeuroFlow workflow document, check it with neuroflow_validate \
                 (diagnostics include repair hints), then execute it with neuroflow_run. \
                 Pass file inputs as absolute paths inside the allowed data roots or as neuroflow:// URIs from \
                 earlier results. Read an artifact URI to get a summary (dimensions, orientation, label volumes, \
                 dataset layout) instead of raw bytes. Use neuroflow_inspect to check an input file's \
                 contents before relying on assumptions from its name. Every run writes a provenance record."
            ),
        })
    }

    // ------------------------------------------------------------------ tools

    fn list_tools(&self) -> Vec<Value> {
        let mut tools = vec![
            self.fixed_tool(
                "neuroflow_list",
                "List NeuroFlow tools and workflows",
                "List the tools and workflows in this server's registry with their typed inputs and outputs, and whether this server can run them. Use acceptsType / producesType to find tools that chain (for example, what consumes a neuro:label-map).",
                json!({ "type": "object", "properties": {
                    "kind": { "type": "string", "enum": ["tool", "workflow"] },
                    "stage": { "type": "string", "enum": ["ingest", "explore", "publish"] },
                    "acceptsType": { "type": "string", "description": "A NeuroFlow type such as neuro:volume; matches documents with a compatible input." },
                    "producesType": { "type": "string", "description": "A NeuroFlow type; matches documents with a compatible output." },
                    "runnableOnly": { "type": "boolean" }
                }, "additionalProperties": false }),
                true,
            ),
            self.fixed_tool(
                "neuroflow_describe",
                "Describe a NeuroFlow document",
                "Return the full NeuroFlow tool or workflow document for an id or MCP tool name.",
                json!({ "type": "object", "properties": { "id": { "type": "string" } }, "required": ["id"], "additionalProperties": false }),
                true,
            ),
            self.fixed_tool(
                "neuroflow_validate",
                "Validate a NeuroFlow document",
                "Validate a NeuroFlow workflow (or tool) document against this server's registry. Returns diagnostics with a JSON Pointer and, when possible, a hint listing valid alternatives. Validate before calling neuroflow_run.",
                json!({ "type": "object", "properties": { "document": { "type": "object", "description": "A NeuroFlow document (kind workflow or tool)." } }, "required": ["document"], "additionalProperties": false }),
                true,
            ),
            self.fixed_tool(
                "neuroflow_inspect",
                "Inspect a file or folder",
                "Summarize any NIfTI file, table, JSON file, or folder inside the allowed data roots (or a neuroflow:// artifact) without running a tool: dimensions, voxel size, orientation, intensity range and nonzero volume for images; per-label volumes when type is neuro:label-map or neuro:mask; subjects and datatypes for BIDS datasets. Use it to check assumptions about inputs (for example, whether an image is already skull-stripped) instead of inferring from file or folder names.",
                json!({ "type": "object", "properties": {
                    "path": { "type": "string", "description": "Absolute path inside an allowed data root, or a neuroflow:// artifact URI." },
                    "type": { "type": "string", "description": "Optional NeuroFlow type to interpret it as, e.g. neuro:label-map or neuro:mask for label statistics." }
                }, "required": ["path"], "additionalProperties": false }),
                true,
            ),
            self.fixed_tool(
                "neuroflow_plan",
                "Plan a NeuroFlow workflow",
                "Return the execution order, bindings, and outputs of a workflow (inline or by id), and whether this server can run it.",
                json!({ "type": "object", "properties": {
                    "workflow": { "type": "object" }, "id": { "type": "string" }
                }, "additionalProperties": false }),
                true,
            ),
        ];
        let mut run = self.fixed_tool(
            "neuroflow_run",
            "Run a NeuroFlow workflow",
            "Execute a workflow given inline (a document you composed) or by registry id, with its inputs. Only registered tools run, through their declared launch contracts. Returns outputs as neuroflow:// artifact URIs plus a provenance record. Calling it again in this session with the same workflow and inputs returns the earlier completed run instead of executing again; set rerun to force a new run.",
            json!({ "type": "object", "properties": {
                "workflow": { "type": "object", "description": "Inline NeuroFlow workflow document." },
                "id": { "type": "string", "description": "Registry workflow id (instead of workflow)." },
                "inputs": { "type": "object", "description": "Values for the workflow's declared inputs." },
                "rerun": rerun_schema()
            }, "additionalProperties": false }),
            false,
        );
        run["annotations"]["idempotentHint"] = json!(true);
        if self.modern() {
            run["outputSchema"] = run_output_schema();
        }
        tools.push(run);

        for doc in self.registry.docs.iter().filter(|d| d.mcp_name.is_some()) {
            let name = doc.mcp_name.clone().unwrap_or_default();
            let mut description = doc.description().to_string();
            if let Some(stage) = doc.stage() {
                description.push_str(&format!(" Stage: {stage}."));
            }
            description.push_str(&format!(" NeuroFlow {} {}@{}.", doc.kind.as_str(), doc.id, doc.version));
            let value_types = value_types_of(&doc.value);
            let mut schema = input_schema(doc.value.get("inputs").and_then(Value::as_object), &value_types);
            schema["properties"]["rerun"] = rerun_schema();
            let mut tool = json!({
                "name": name,
                "description": description,
                "inputSchema": schema,
                "annotations": self.annotations(doc),
            });
            if self.modern() {
                tool["title"] = json!(doc.title);
                tool["outputSchema"] = run_output_schema();
            }
            tools.push(tool);
        }
        tools
    }

    fn fixed_tool(&self, name: &str, title: &str, description: &str, schema: Value, read_only: bool) -> Value {
        let mut t = json!({
            "name": name,
            "description": description,
            "inputSchema": schema,
            "annotations": { "readOnlyHint": read_only, "destructiveHint": false, "openWorldHint": false },
        });
        if self.modern() {
            t["title"] = json!(title);
        }
        t
    }

    /// RFC 0009 section 1.5.
    fn annotations(&self, doc: &crate::registry::Doc) -> Value {
        let emits_fixes = |tool: &Value| {
            tool.pointer("/events/emits")
                .and_then(Value::as_object)
                .is_some_and(|m| m.values().any(|c| c.get("type").and_then(Value::as_str) == Some("core:fix-proposal")))
        };
        let destructive = match doc.kind {
            Kind::Tool => emits_fixes(&doc.value),
            Kind::Workflow => doc.value.get("steps").and_then(Value::as_object).is_some_and(|steps| {
                steps.values().any(|s| {
                    s.get("fixLoop").is_some()
                        || s.get("tool")
                            .and_then(Value::as_str)
                            .and_then(|t| self.registry.tool(t))
                            .is_some_and(|t| emits_fixes(&t.value))
                })
            }),
        };
        // Idempotent within a session: a repeated call with identical inputs replays the completed run.
        let mut a = json!({ "readOnlyHint": false, "destructiveHint": destructive, "idempotentHint": true, "openWorldHint": false });
        if let Some(over) = doc.value.pointer("/extensions/neuroflow~1mcp/annotations").and_then(Value::as_object) {
            for (k, v) in over {
                a[k] = v.clone();
            }
        }
        if self.modern() {
            a["title"] = json!(doc.title);
        }
        a
    }

    fn call_tool(&mut self, params: &Value) -> Result<Value, (i64, String)> {
        let name = params.get("name").and_then(Value::as_str).unwrap_or("");
        let args = params.get("arguments").cloned().unwrap_or(json!({}));
        let mut args = args.as_object().cloned().unwrap_or_default();
        let token = params.pointer("/_meta/progressToken").cloned();
        let rerun = args.remove("rerun").and_then(|v| v.as_bool()).unwrap_or(false);
        match name {
            "neuroflow_list" => Ok(self.ok_json(self.list(&args))),
            "neuroflow_describe" => {
                let key = args.get("id").and_then(Value::as_str).unwrap_or("");
                match self.registry.resolve(key) {
                    Some(doc) => Ok(self.ok_json(json!({
                        "id": doc.id, "kind": doc.kind.as_str(), "mcpName": doc.mcp_name,
                        "runnable": doc.runnable.is_ok(), "notRunnableReason": doc.runnable.as_ref().err(),
                        "document": doc.value,
                    }))),
                    None => Ok(tool_error(format!("unknown document {key:?}; call neuroflow_list for ids"))),
                }
            }
            "neuroflow_inspect" => {
                let path = args.get("path").cloned().unwrap_or(Value::Null);
                match runtime::resolve_artifact(&self.cfg, &path) {
                    Err(e) => Ok(tool_error(e)),
                    Ok(resolved) => {
                        let p = std::path::Path::new(&resolved);
                        let t = args.get("type").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| {
                            if p.is_dir() {
                                if p.join("dataset_description.json").is_file() { "neuro:bids-dataset" } else { "core:directory" }
                            } else {
                                let lower = resolved.to_ascii_lowercase();
                                if lower.ends_with(".nii") || lower.ends_with(".nii.gz") { "neuro:volume" }
                                else if lower.ends_with(".tsv") || lower.ends_with(".csv") { "core:tabular" }
                                else if lower.ends_with(".json") { "core:json" }
                                else { "core:file" }
                            }.to_string()
                        });
                        Ok(self.ok_json(artifacts::summarize(&resolved, &t, self.cfg.summary_max_bytes)))
                    }
                }
            }
            "neuroflow_validate" => {
                let doc = args.get("document").cloned().unwrap_or(Value::Null);
                let report = self.validate(&doc);
                Ok(self.ok_json(report))
            }
            "neuroflow_plan" => match self.workflow_arg(&args) {
                Ok(wf) => {
                    let plan = neuroflow_core::plan_workflow_value(&wf);
                    let order = step_order(&wf);
                    let runnable = self.registry.workflow_runnable(&wf);
                    let validation = self.validate(&wf);
                    Ok(self.ok_json(json!({
                        "plan": plan,
                        "executionOrder": order.as_ref().ok(),
                        "orderError": order.as_ref().err(),
                        "runnable": runnable.is_ok() && validation["runnable"] == true,
                        "conditional": validation["conditional"],
                        "validation": validation,
                        "notRunnableReason": runnable.err().map(Value::String).unwrap_or_else(|| validation["notRunnableReason"].clone()),
                    })))
                }
                Err(e) => Ok(tool_error(e)),
            },
            "neuroflow_run" => {
                let wf = match self.workflow_arg(&args) {
                    Ok(wf) => wf,
                    Err(e) => return Ok(tool_error(e)),
                };
                let report = self.validate(&wf);
                if report["valid"] != json!(true) {
                    let mut r = tool_error(format!(
                        "Workflow is not valid; nothing was run. Fix the diagnostics and retry.\n{}",
                        serde_json::to_string_pretty(&report["diagnostics"]).unwrap_or_default()
                    ));
                    if self.modern() {
                        r["structuredContent"] = json!({ "runId": "", "status": "failed", "error": "invalid workflow", "diagnostics": report["diagnostics"] });
                    }
                    return Ok(r);
                }
                let inputs = args.get("inputs").and_then(Value::as_object).cloned().unwrap_or_default();
                Ok(self.execute(&wf, &inputs, token, rerun))
            }
            other => {
                let Some(doc) = self.registry.by_mcp_name(other) else {
                    return Err((-32602, format!("unknown tool {other}")));
                };
                let wf = match doc.kind {
                    Kind::Workflow => doc.value.clone(),
                    Kind::Tool => runtime::wrap_tool(doc),
                };
                Ok(self.execute(&wf, &args, token, rerun))
            }
        }
    }

    fn execute(&mut self, wf: &Value, inputs: &Map<String, Value>, token: Option<Value>, rerun: bool) -> Value {
        // Same work already done in this session: answer with that run. Input
        // resolution errors fall through to run_workflow, which reports them.
        let key = runtime::resolve_inputs(&self.cfg, wf, inputs).ok().map(|i| runtime::fingerprint(&self.registry, wf, &i));
        if let Some(key) = &key {
            if let Some((run_id, result)) = self.completed.get(key) {
                if !rerun {
                    if let Some(replay) = self.replay(run_id, result) {
                        return replay;
                    }
                }
                self.completed.remove(key);
            }
        }
        let result = self.execute_now(wf, inputs, token);
        if let (Some(key), Some(run_id)) = (key, result.pointer("/structuredContent/runId").and_then(Value::as_str)) {
            if result.pointer("/structuredContent/status") == Some(&json!("completed")) {
                self.completed.insert(key, (run_id.to_string(), result.clone()));
            }
        }
        result
    }

    /// The earlier run's result, restated, provided its session is still on disk.
    fn replay(&self, run_id: &str, result: &Value) -> Option<Value> {
        let record = std::fs::read_to_string(self.cfg.sessions_root.join(run_id).join("run.json")).ok()?;
        let record: Value = serde_json::from_str(&record).ok()?;
        if record.get("status") != Some(&json!("completed")) {
            return None;
        }
        for step in record["steps"].as_object()?.values() {
            if !qualifiers::unchanged(&step["inputEvidence"]) || !qualifiers::unchanged(&step["outputEvidence"]) {
                return None;
            }
        }
        let ended = record.get("endedAt").and_then(Value::as_str).unwrap_or("earlier");
        let mut replay = result.clone();
        if let Some(text) = result.pointer("/content/0/text").and_then(Value::as_str).map(str::to_string) {
            let rest = text.strip_prefix(&format!("Run {run_id} completed:")).unwrap_or(&text).trim_start().to_string();
            replay["content"][0]["text"] = json!(format!(
                "Reused run {run_id}: this workflow already ran with identical inputs in this session \
                 (completed {ended}), so nothing was executed or written again. Pass \"rerun\": true to run it anew. {rest}"
            ));
        }
        if replay.get("structuredContent").is_some() {
            replay["structuredContent"]["reused"] = json!(true);
        }
        Some(replay)
    }

    fn execute_now(&self, wf: &Value, inputs: &Map<String, Value>, token: Option<Value>) -> Value {
        let mut progress = |done: f64, total: f64, message: &str| {
            if let Some(token) = &token {
                send(&json!({ "jsonrpc": "2.0", "method": "notifications/progress",
                    "params": { "progressToken": token, "progress": done, "total": total, "message": message } }));
            }
        };
        match runtime::run_workflow(&self.cfg, &self.registry, wf, inputs, &self.client, &mut progress) {
            Err(e) => tool_error(format!("Run rejected before any step started: {e}")),
            Ok(outcome) => {
                let mut content = vec![json!({ "type": "text", "text": outcome.summary })];
                if self.modern() {
                    for (uri, name, mime, description) in &outcome.links {
                        let mut link = json!({ "type": "resource_link", "uri": uri, "name": name, "description": description });
                        if !mime.is_empty() {
                            link["mimeType"] = json!(mime);
                        }
                        content.push(link);
                    }
                } else {
                    content.push(json!({ "type": "text", "text": serde_json::to_string_pretty(&outcome.structured).unwrap_or_default() }));
                }
                let mut result = json!({ "content": content, "isError": outcome.is_error() });
                if self.modern() {
                    result["structuredContent"] = outcome.structured;
                }
                let _ = &outcome.run_id;
                let _ = &outcome.status;
                result
            }
        }
    }

    fn workflow_arg(&self, args: &Map<String, Value>) -> Result<Value, String> {
        match (args.get("workflow"), args.get("id").and_then(Value::as_str)) {
            (Some(wf), None) if wf.is_object() => Ok(wf.clone()),
            (None, Some(id)) => {
                let doc = self.registry.resolve(id).ok_or_else(|| format!("unknown document {id:?}"))?;
                Ok(match doc.kind {
                    Kind::Workflow => doc.value.clone(),
                    Kind::Tool => runtime::wrap_tool(doc),
                })
            }
            _ => Err("pass exactly one of `workflow` (an inline document) or `id`".into()),
        }
    }

    fn ok_json(&self, v: Value) -> Value {
        let mut r = json!({ "content": [{ "type": "text", "text": serde_json::to_string_pretty(&v).unwrap_or_default() }] });
        if self.modern() && v.is_object() {
            r["structuredContent"] = v;
        }
        r
    }

    fn validate(&self, doc: &Value) -> Value {
        let kind = doc.get("kind").and_then(Value::as_str).unwrap_or("");
        let issues: Vec<Value> = if kind == "tool" {
            validate_tool(doc)
        } else {
            let tools = self.registry.tools_array();
            let report = neuroflow_core::validate_workflow_value_with_tools(doc, Some(&tools));
            report
                .issues
                .iter()
                .map(|i| {
                    let mut d = json!({ "severity": i.severity, "message": i.message });
                    if let Some(p) = &i.path {
                        d["pointer"] = json!(format!("/{}", p.replace('.', "/")));
                    }
                    if let Some(h) = &i.hint {
                        d["hint"] = json!(h);
                    }
                    d
                })
                .collect()
        };
        let valid = !issues.iter().any(|i| i["severity"] == "error");
        let conditional = issues.iter().any(|issue| issue["message"].as_str().is_some_and(|message| message.contains("requires a runtime check")));
        let mut out = json!({ "valid": valid, "conditional": conditional, "diagnostics": issues,
            "qualifierInspectors": qualifiers::capabilities() });
        if valid && kind == "workflow" {
            match self.registry.workflow_runnable(doc) {
                Ok(()) => {
                    out["runnable"] = json!(!conditional);
                    if conditional { out["notRunnableReason"] = json!("qualifier checks need artifact evidence before execution"); }
                },
                Err(reason) => {
                    out["runnable"] = json!(false);
                    out["notRunnableReason"] = json!(reason);
                }
            }
        }
        out
    }

    fn list(&self, args: &Map<String, Value>) -> Value {
        let s = |k: &str| args.get(k).and_then(Value::as_str);
        let accepts = s("acceptsType");
        let produces = s("producesType");
        let compatible = |from: &str, to: &str| {
            neuroflow_core::is_type_compatible(from, to) || neuroflow_core::is_type_compatible(from, element_type(to))
                || neuroflow_core::is_type_compatible(element_type(from), element_type(to))
        };
        let types_of = |doc: &Value, key: &str| -> Map<String, Value> {
            doc.get(key)
                .and_then(Value::as_object)
                .into_iter()
                .flatten()
                .map(|(n, d)| (n.clone(), d.get("type").cloned().unwrap_or(Value::Null)))
                .collect()
        };
        let items: Vec<Value> = self
            .registry
            .docs
            .iter()
            .filter(|d| s("kind").is_none_or(|k| k == d.kind.as_str()))
            .filter(|d| s("stage").is_none_or(|st| d.stage() == Some(st)))
            .filter(|d| !args.get("runnableOnly").and_then(Value::as_bool).unwrap_or(false) || d.runnable.is_ok())
            .filter(|d| {
                accepts.is_none_or(|t| types_of(&d.value, "inputs").values().filter_map(Value::as_str).any(|i| compatible(t, i)))
            })
            .filter(|d| {
                produces.is_none_or(|t| types_of(&d.value, "outputs").values().filter_map(Value::as_str).any(|o| compatible(o, t)))
            })
            .map(|d| {
                json!({
                    "id": d.id, "kind": d.kind.as_str(), "version": d.version, "title": d.title,
                    "stage": d.stage(), "mcpName": d.mcp_name,
                    "runnable": d.runnable.is_ok(), "notRunnableReason": d.runnable.as_ref().err(),
                    "inputs": types_of(&d.value, "inputs"), "outputs": types_of(&d.value, "outputs"),
                })
            })
            .collect();
        json!({ "count": items.len(), "items": items })
    }

    fn get_prompt(&self, params: &Value) -> Result<Value, (i64, String)> {
        if params.get("name").and_then(Value::as_str) != Some("neuroflow_author_workflow") {
            return Err((-32602, "unknown prompt".into()));
        }
        let goal = params.pointer("/arguments/goal").and_then(Value::as_str).unwrap_or("");
        let mut catalog = String::new();
        for d in self.registry.docs.iter().filter(|d| d.kind == Kind::Tool) {
            let fmt = |key: &str| {
                d.value.get(key).and_then(Value::as_object).into_iter().flatten()
                    .map(|(n, decl)| {
                        let t = decl.get("type").and_then(Value::as_str).unwrap_or("?");
                        let opt = if crate::schema::is_required(decl) { "" } else { "?" };
                        format!("{n}{opt}: {t}")
                    })
                    .collect::<Vec<_>>()
                    .join(", ")
            };
            catalog.push_str(&format!(
                "- {} @{} ({}): inputs [{}] -> outputs [{}]\n",
                d.id,
                d.version,
                if d.runnable.is_ok() { "runnable" } else { "not runnable here" },
                fmt("inputs"),
                fmt("outputs")
            ));
        }
        let text = format!(
            "Compose a NeuroFlow 0.1 workflow{}.\n\n\
             Document shape: {{\"neuroflow\":\"0.1.0\",\"kind\":\"workflow\",\"id\":\"<namespace>/<name>\",\"version\":\"1.0.0\",\
             \"description\":\"...\",\"inputs\":{{name: {{\"type\":...,\"description\":...}}}},\"steps\":{{stepId: {{\"tool\":\"<tool id>\",\
             \"inputs\":{{toolInput: binding}}}}}},\"outputs\":{{name: {{\"type\":...,\"ref\":\"steps.<step>.outputs.<output>\"}}}}}}\n\
             A binding is exactly one of {{\"ref\": ...}} or {{\"constant\": ...}}. References: inputs.<name>, context, context.<field>, \
             steps.<step>.outputs.<output>. Local ids match ^[a-z][A-Za-z0-9]*(?:[-_][A-Za-z0-9]+)*$. Types are namespace-qualified \
             (core:, neuro:, bids:, prov:), arrays are core:array<T>.\n\
             Validate with neuroflow_validate, fix any diagnostics (hints list valid names), then run with neuroflow_run.\n\n\
             Tools in this registry:\n{catalog}",
            if goal.is_empty() { String::new() } else { format!(" that will: {goal}") }
        );
        Ok(json!({
            "description": "Guide for composing a NeuroFlow workflow from this registry.",
            "messages": [{ "role": "user", "content": { "type": "text", "text": text } }]
        }))
    }
}

fn validate_tool(doc: &Value) -> Vec<Value> {
    let mut out: Vec<Value> = neuroflow_core::qualifiers::validate_document_qualifiers(doc).iter().map(|issue|
        json!({ "severity": issue.severity, "pointer": issue.path.as_ref().map(|p| format!("/{}", p.replace('.', "/"))), "message": issue.message })
    ).collect();
    let mut err = |pointer: &str, message: &str| out.push(json!({ "severity": "error", "pointer": pointer, "message": message }));
    if !neuroflow_core::is_supported_spec_version(doc.get("neuroflow").and_then(Value::as_str)) {
        err("/neuroflow", "neuroflow must be \"0.1.0\" or \"0.1.1\".");
    }
    if !doc.get("id").and_then(Value::as_str).is_some_and(|id| id.contains('/')) {
        err("/id", "id must be namespace-qualified (contain '/').");
    }
    for key in ["inputs", "outputs"] {
        match doc.get(key).and_then(Value::as_object) {
            None => err(&format!("/{key}"), &format!("{key} must be an object.")),
            Some(map) => {
                for (name, decl) in map {
                    if decl.get("type").and_then(Value::as_str).is_none_or(|t| !t.contains(':')) {
                        err(&format!("/{key}/{name}/type"), "type must be a namespace-qualified type string.");
                    }
                }
            }
        }
    }
    out
}

fn rerun_schema() -> Value {
    json!({ "type": "boolean", "default": false,
            "description": "Execute again even though this workflow already completed with identical inputs in this session (by default that earlier run is returned)." })
}

fn tool_error(message: String) -> Value {
    json!({ "content": [{ "type": "text", "text": message }], "isError": true })
}

fn server_info() -> Value {
    json!({ "name": "neuroflow-mcp", "title": "NeuroFlow", "version": env!("CARGO_PKG_VERSION") })
}

fn send(v: &Value) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{}", serde_json::to_string(v).unwrap_or_default());
    let _ = out.flush();
}
