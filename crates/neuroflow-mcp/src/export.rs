//! Package a finished run as a BIDS-Derivatives folder (RFC 0003 section 10):
//! `dataset_description.json` with a `GeneratedBy[]` built from the
//! provenance record, the run's public outputs, the executed workflow under
//! `code/`, and the record itself as the sibling `<runId>_prov.json`.
//!
//! Everything comes from `run.provenance.json`, and every copied file or folder
//! is checked against the checksum recorded for it, so the package is exactly
//! what the run produced. Output files keep their tool-given names: the run
//! carries no subject or session labels, so the folder is derivatives-shaped,
//! not a dataset the BIDS validator will pass.

use crate::qualifiers::{content_hash, tree_hash};
use crate::runtime::write_json;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

/// The BIDS version `dataset_description.json` declares.
pub const BIDS_VERSION: &str = "1.10.0";
/// Name of the package folder inside the run's session directory.
pub const EXPORT_DIR: &str = "derivatives";

/// Write `<session>/derivatives/` for a completed run and describe what it holds.
/// An earlier export of the same run is replaced, but only once the new one is
/// complete: a failed export leaves it as it was.
pub fn export_run(sessions_root: &Path, run_id: &str) -> Result<Value, String> {
    if run_id.is_empty()
        || !run_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(format!("not a run id: {run_id:?}"));
    }
    let session = sessions_root.join(run_id);
    let text = fs::read_to_string(session.join("run.provenance.json"))
        .map_err(|_| format!("no provenance record for run {run_id}"))?;
    let prov: Value = serde_json::from_str(&text)
        .map_err(|e| format!("run {run_id}: unreadable provenance record: {e}"))?;
    let status = prov
        .pointer("/run/status")
        .and_then(Value::as_str)
        .unwrap_or("");
    if status != "completed" {
        return Err(format!(
            "run {run_id} is {status}; only completed runs are exported"
        ));
    }

    let staging = session.join(format!("{EXPORT_DIR}.partial"));
    let _ = fs::remove_dir_all(&staging);
    let written = write_package(&prov, &session, &staging, run_id);
    let files = match written {
        Ok(files) => files,
        Err(e) => {
            let _ = fs::remove_dir_all(&staging);
            return Err(e);
        }
    };
    let target = session.join(EXPORT_DIR);
    let _ = fs::remove_dir_all(&target);
    fs::rename(&staging, &target)
        .map_err(|e| format!("cannot move the package into place: {e}"))?;
    Ok(json!({ "runId": run_id, "path": target.to_string_lossy(), "files": files }))
}

fn write_package(
    prov: &Value,
    session: &Path,
    root: &Path,
    run_id: &str,
) -> Result<Vec<Value>, String> {
    let entities: HashMap<&str, &Value> = prov["entities"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|e| Some((e.get("id")?.as_str()?, e)))
        .collect();
    let mut files = Vec::new();
    for (key, id) in prov["outputs"].as_object().into_iter().flatten() {
        let entity = id
            .as_str()
            .and_then(|id| entities.get(id))
            .ok_or_else(|| format!("output {key}: no entity {id}"))?;
        // `name.0` for an element of an array output. Output names are not
        // constrained by the schema, so keep each part a plain folder name.
        let parts: Vec<&str> = key.split('.').collect();
        if parts
            .iter()
            .any(|p| p.is_empty() || *p == ".." || p.contains(['/', '\\', ':']))
        {
            return Err(format!("output {key:?} is not a usable folder name"));
        }
        let dir = root.join(parts.join("/"));
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        if let Some(src) = entity.get("path").and_then(Value::as_str) {
            let src = Path::new(src);
            let name = src
                .file_name()
                .ok_or_else(|| format!("output {key}: no file name in {}", src.display()))?;
            let dest = dir.join(name);
            let hash = if src.is_dir() {
                copy_tree(src, &dest)?;
                tree_hash(&dest, &HashMap::new())?
            } else {
                fs::copy(src, &dest)
                    .map_err(|e| format!("output {key}: cannot copy {}: {e}", src.display()))?;
                content_hash(&dest, &HashMap::new())?
            };
            files.push(checked(key, &dest, root, &hash, entity.get("checksum"))?);
        } else {
            let dest = dir.join(format!("{key}.json"));
            write_json(&dest, &entity["value"])?;
            files.push(json!({ "output": key, "path": relative(&dest, root), "embedded": true }));
        }
    }

    let code = root.join("code");
    fs::create_dir_all(&code).map_err(|e| e.to_string())?;
    let workflow = code.join("workflow.json");
    fs::copy(session.join("workflow.json"), &workflow)
        .map_err(|e| format!("cannot copy workflow.json: {e}"))?;
    let hash = content_hash(&workflow, &HashMap::new())?;
    files.push(checked(
        "workflow",
        &workflow,
        root,
        &hash,
        prov.pointer("/workflow/checksum"),
    )?);

    let record = root.join(format!("{run_id}_prov.json"));
    fs::copy(session.join("run.provenance.json"), &record)
        .map_err(|e| format!("cannot copy the provenance record: {e}"))?;
    files.push(
        json!({ "output": "provenance", "path": relative(&record, root),
        "sha256": content_hash(&record, &HashMap::new())? }),
    );

    let workflow_doc = fs::read_to_string(&workflow)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or(Value::Null);
    let description = root.join("dataset_description.json");
    write_json(
        &description,
        &dataset_description(prov, &workflow_doc, run_id),
    )?;
    files.push(json!({ "output": "dataset_description", "path": relative(&description, root) }));
    Ok(files)
}

/// A file entry, failing when the copy differs from what the run recorded.
fn checked(
    key: &str,
    dest: &Path,
    root: &Path,
    hash: &str,
    recorded: Option<&Value>,
) -> Result<Value, String> {
    let mut entry = json!({ "output": key, "path": relative(dest, root), "sha256": hash });
    match recorded
        .and_then(|c| c.get("value"))
        .and_then(Value::as_str)
    {
        Some(expected) if expected != hash => {
            return Err(format!(
                "{key} changed since the run: recorded sha256 {expected}, found {hash}"
            ));
        }
        Some(_) => entry["verified"] = json!(true),
        None => entry["verified"] = json!(false),
    }
    Ok(entry)
}

/// Copy regular files and directories; links are skipped, as `tree_hash` skips them.
fn copy_tree(src: &Path, dest: &Path) -> Result<(), String> {
    fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(src).map_err(|e| format!("{}: {e}", src.display()))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        let to: PathBuf = dest.join(entry.file_name());
        if kind.is_dir() {
            copy_tree(&entry.path(), &to)?;
        } else if kind.is_file() {
            fs::copy(entry.path(), &to)
                .map_err(|e| format!("cannot copy {}: {e}", entry.path().display()))?;
        }
    }
    Ok(())
}

fn relative(path: &Path, root: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

/// BIDS `dataset_description.json` for a derivative. `GeneratedBy` is the
/// compacted record: the workflow first (named by its `bids/profile`
/// `pipelineName` when it sets one), then each distinct software agent.
pub fn dataset_description(prov: &Value, workflow: &Value, run_id: &str) -> Value {
    let wf_id = prov
        .pointer("/workflow/id")
        .and_then(Value::as_str)
        .unwrap_or("workflow");
    let wf_version = prov
        .pointer("/workflow/version")
        .and_then(Value::as_str)
        .unwrap_or("0.0.0");
    let name = workflow
        .pointer("/extensions/bids~1profile/outputDataset/pipelineName")
        .and_then(Value::as_str)
        .unwrap_or(wf_id);
    let mut description = format!("NeuroFlow workflow {wf_id}, run {run_id}");
    if let Some(hash) = prov
        .pointer("/workflow/checksum/value")
        .and_then(Value::as_str)
    {
        description.push_str(&format!(" (code/workflow.json sha256 {hash})"));
    }
    description.push_str(&format!(
        ". {run_id}_prov.json is the full provenance record."
    ));
    let mut generated =
        vec![json!({ "Name": name, "Version": wf_version, "Description": description })];
    let mut seen = Vec::new();
    for agent in prov["agents"].as_array().into_iter().flatten() {
        let Some(agent_name) = agent.get("name").and_then(Value::as_str) else {
            continue;
        };
        let version = agent.get("version").and_then(Value::as_str);
        if seen.contains(&(agent_name, version)) {
            continue;
        }
        seen.push((agent_name, version));
        let mut entry = Map::new();
        entry.insert("Name".into(), json!(agent_name));
        if let Some(v) = version {
            entry.insert("Version".into(), json!(v));
        }
        let role = match agent.get("role").and_then(Value::as_str) {
            Some("runtime") => "NeuroFlow runtime that executed the workflow",
            Some("mcp-client") => "MCP client that requested the run",
            Some("tool") => "NeuroFlow tool document run as a step",
            Some("reported-by-tool") => "software a step reported running",
            _ => "agent in the provenance record",
        };
        entry.insert("Description".into(), json!(role));
        generated.push(Value::Object(entry));
    }
    json!({
        "Name": format!("{name} ({run_id})"),
        "BIDSVersion": BIDS_VERSION,
        "DatasetType": "derivative",
        "GeneratedBy": generated,
    })
}
