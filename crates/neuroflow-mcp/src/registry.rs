//! Tool and workflow registry: loads NeuroFlow documents from disk, derives
//! MCP tool names (RFC 0009 section 1.1), and decides which documents this
//! server can execute.

use crate::util::find_on_path;
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Interpreters a `script` launch may use. Tools never get a shell.
pub const ALLOWED_INTERPRETERS: &[&str] = &["python3", "python", "node", "Rscript"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Tool,
    Workflow,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Tool => "tool",
            Kind::Workflow => "workflow",
        }
    }
}

#[derive(Debug, Clone)]
pub struct Launch {
    pub interpreter: PathBuf,
    pub script: PathBuf,
}

#[derive(Debug, Clone)]
pub struct Doc {
    pub kind: Kind,
    pub id: String,
    pub version: String,
    pub value: Value,
    pub source: PathBuf,
    /// Registry root this document was loaded from.
    pub root: PathBuf,
    pub title: String,
    /// Ok when this server can execute the document, Err(reason) otherwise.
    pub runnable: Result<(), String>,
    /// MCP tool name, present only for exposed, runnable documents.
    pub mcp_name: Option<String>,
}

impl Doc {
    pub fn stage(&self) -> Option<&str> {
        self.value
            .pointer("/extensions/niivue~1ui/block/stage")
            .and_then(Value::as_str)
            .or_else(|| {
                self.value
                    .pointer("/extensions/niivue~1ui/block/0/stage")
                    .and_then(Value::as_str)
            })
    }

    pub fn description(&self) -> &str {
        self.value.get("description").and_then(Value::as_str).unwrap_or("")
    }

    fn mcp_ext(&self) -> Option<&Value> {
        self.value.pointer("/extensions/neuroflow~1mcp")
    }
}

pub struct Registry {
    pub docs: Vec<Doc>,
    by_id: HashMap<String, usize>,
    by_name: HashMap<String, usize>,
    pub warnings: Vec<String>,
}

impl Registry {
    pub fn load(dirs: &[PathBuf], interpreters: &HashMap<String, PathBuf>) -> Result<Self, String> {
        let mut docs: Vec<Doc> = Vec::new();
        let mut warnings = Vec::new();
        let mut by_id: HashMap<String, usize> = HashMap::new();

        for dir in dirs {
            let root = dir
                .canonicalize()
                .map_err(|err| format!("registry directory {}: {err}", dir.display()))?;
            let mut files = Vec::new();
            collect_json(&root, &mut files);
            files.sort();
            for file in files {
                let Ok(text) = std::fs::read_to_string(&file) else { continue };
                let Ok(value) = serde_json::from_str::<Value>(&text) else {
                    warnings.push(format!("skipped {}: not valid JSON", file.display()));
                    continue;
                };
                let kind = match value.get("kind").and_then(Value::as_str) {
                    Some("tool") => Kind::Tool,
                    Some("workflow") => Kind::Workflow,
                    _ => continue,
                };
                if !neuroflow_core::is_supported_spec_version(
                    value.get("neuroflow").and_then(Value::as_str),
                ) {
                    continue;
                }
                let Some(id) = value.get("id").and_then(Value::as_str).map(str::to_string) else {
                    continue;
                };
                if by_id.contains_key(&id) {
                    warnings.push(format!(
                        "skipped {}: duplicate document id {id}",
                        file.display()
                    ));
                    continue;
                }
                let version = value
                    .get("version")
                    .and_then(Value::as_str)
                    .unwrap_or("0.0.0")
                    .to_string();
                let title = title_of(&value, &id);
                by_id.insert(id.clone(), docs.len());
                docs.push(Doc {
                    kind,
                    id,
                    version,
                    value,
                    source: file,
                    root: root.clone(),
                    title,
                    runnable: Ok(()),
                    mcp_name: None,
                });
            }
        }

        let mut registry = Registry {
            docs,
            by_id,
            by_name: HashMap::new(),
            warnings,
        };

        // Tools first, then workflows (which depend on tool runnability).
        for i in 0..registry.docs.len() {
            if registry.docs[i].kind == Kind::Tool {
                let doc = &registry.docs[i];
                let runnable = launch_of(doc, interpreters).map(|_| ());
                registry.docs[i].runnable = runnable;
            }
        }
        for i in 0..registry.docs.len() {
            if registry.docs[i].kind == Kind::Workflow {
                let runnable = registry.workflow_runnable(&registry.docs[i].value);
                registry.docs[i].runnable = runnable;
            }
        }

        // MCP names for exposed, runnable documents; collisions reject the registry.
        for i in 0..registry.docs.len() {
            let doc = &registry.docs[i];
            let expose = doc
                .mcp_ext()
                .and_then(|ext| ext.get("expose"))
                .and_then(Value::as_bool)
                .unwrap_or(true);
            if !expose || doc.runnable.is_err() {
                continue;
            }
            let name = match doc.mcp_ext().and_then(|e| e.get("name")).and_then(Value::as_str) {
                Some(explicit) => explicit.to_string(),
                None => derive_name(&doc.id),
            };
            if name.is_empty() || name.len() > 64 {
                registry.warnings.push(format!(
                    "not exposing {}: derived tool name is longer than 64 characters; set extensions[\"neuroflow/mcp\"].name",
                    doc.id
                ));
                continue;
            }
            if name.starts_with("neuroflow_") {
                registry.warnings.push(format!(
                    "not exposing {}: tool names beginning with neuroflow_ are reserved",
                    doc.id
                ));
                continue;
            }
            if let Some(&other) = registry.by_name.get(&name) {
                return Err(format!(
                    "MCP tool name collision: {} and {} both resolve to {name}",
                    registry.docs[other].id, doc.id
                ));
            }
            registry.by_name.insert(name.clone(), i);
            registry.docs[i].mcp_name = Some(name);
        }

        Ok(registry)
    }

    pub fn get(&self, id: &str) -> Option<&Doc> {
        self.by_id.get(id).map(|&i| &self.docs[i])
    }

    pub fn by_mcp_name(&self, name: &str) -> Option<&Doc> {
        self.by_name.get(name).map(|&i| &self.docs[i])
    }

    /// Look up by document id or MCP tool name.
    pub fn resolve(&self, key: &str) -> Option<&Doc> {
        self.get(key).or_else(|| self.by_mcp_name(key))
    }

    pub fn tool(&self, id: &str) -> Option<&Doc> {
        self.get(id).filter(|doc| doc.kind == Kind::Tool)
    }

    /// Tool documents as the array neuroflow-core's validator expects.
    pub fn tools_array(&self) -> Value {
        Value::Array(
            self.docs
                .iter()
                .filter(|doc| doc.kind == Kind::Tool)
                .map(|doc| doc.value.clone())
                .collect(),
        )
    }

    /// Whether this server can execute a workflow document (registered or inline).
    pub fn workflow_runnable(&self, workflow: &Value) -> Result<(), String> {
        let steps = workflow
            .get("steps")
            .and_then(Value::as_object)
            .ok_or("workflow has no steps object")?;
        if steps.is_empty() {
            return Err("workflow has no steps".into());
        }
        for (step_id, step) in steps {
            let tool_id = step.get("tool").and_then(Value::as_str).unwrap_or("");
            let tool = self
                .tool(tool_id)
                .ok_or_else(|| format!("step {step_id}: tool {tool_id} is not in the registry"))?;
            if let Err(reason) = &tool.runnable {
                return Err(format!("step {step_id}: {reason}"));
            }
            if step.get("condition").is_some() {
                return Err(format!("step {step_id}: step conditions are not supported by this server yet"));
            }
            if step.get("fixLoop").is_some() {
                return Err(format!("step {step_id}: fix loops are not supported by this server yet"));
            }
            if step.get("awaitApproval").and_then(Value::as_str) == Some("required") {
                return Err(format!("step {step_id}: approvals are not supported by this server yet"));
            }
        }
        Ok(())
    }
}

/// Resolve a tool's `neuroflow/launch` into an executable interpreter and script.
pub fn launch_of(doc: &Doc, interpreters: &HashMap<String, PathBuf>) -> Result<Launch, String> {
    let launch = doc
        .value
        .pointer("/extensions/neuroflow~1launch")
        .ok_or("no neuroflow/launch extension (console and service tools are not supported by this server yet)")?;
    let kind = launch.get("kind").and_then(Value::as_str).unwrap_or("");
    match kind {
        "script" => {}
        "uiApp" => {
            return Err("interactive uiApp tools need an MCP Apps host (RFC 0009 section 6), not yet implemented".into())
        }
        other => return Err(format!("launch kind {other:?} is not supported by this server yet")),
    }
    if launch.get("interactive").and_then(Value::as_bool) == Some(true) {
        return Err("interactive scripts are not supported over MCP".into());
    }
    let interpreter_name = launch.get("interpreter").and_then(Value::as_str).unwrap_or("");
    if !ALLOWED_INTERPRETERS.contains(&interpreter_name) {
        return Err(format!(
            "interpreter {interpreter_name:?} is not allowed (allowed: {})",
            ALLOWED_INTERPRETERS.join(", ")
        ));
    }
    let interpreter = interpreters
        .get(interpreter_name)
        .cloned()
        .or_else(|| find_on_path(interpreter_name))
        .ok_or_else(|| {
            format!("{interpreter_name} was not found on PATH; pass --interpreter {interpreter_name}=/path/to/{interpreter_name}")
        })?;
    let script_rel = launch
        .get("script")
        .and_then(Value::as_str)
        .ok_or("neuroflow/launch has no script")?;
    let base = doc.source.parent().unwrap_or(Path::new("."));
    let script = base
        .join(script_rel)
        .canonicalize()
        .map_err(|_| format!("script {script_rel} not found next to {}", doc.source.display()))?;
    if !script.starts_with(&doc.root) {
        return Err(format!(
            "script {} is outside the registry directory {}",
            script.display(),
            doc.root.display()
        ));
    }
    Ok(Launch { interpreter, script })
}

/// RFC 0009 section 1.1: replace `/` with `.`, drop characters outside `[A-Za-z0-9_.-]`.
pub fn derive_name(id: &str) -> String {
    id.replace('/', ".")
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
        .collect()
}

fn title_of(value: &Value, id: &str) -> String {
    value
        .pointer("/extensions/neuroflow~1mcp/title")
        .and_then(Value::as_str)
        .or_else(|| value.pointer("/extensions/niivue~1ui/block/label").and_then(Value::as_str))
        .or_else(|| value.pointer("/extensions/niivue~1ui/block/0/label").and_then(Value::as_str))
        .unwrap_or(id)
        .to_string()
}

fn collect_json(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || name == "node_modules" || name == "target" {
            continue;
        }
        if path.is_dir() {
            collect_json(&path, out);
        } else if name.ends_with(".json") {
            out.push(path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derives_names_per_rfc() {
        assert_eq!(
            derive_name("neuroflow.gallery.tools/python-volume-filter"),
            "neuroflow.gallery.tools.python-volume-filter"
        );
        assert_eq!(derive_name("niivue.desktop/dicom-to-bids"), "niivue.desktop.dicom-to-bids");
    }
}
