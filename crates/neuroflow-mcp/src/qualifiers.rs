//! Runtime evidence for RFC 0010. Caller declarations are requirements, never
//! evidence. Registered producer contracts supply semantic claims; file readers
//! establish encodings and spacing, and hashes bind those claims to artifacts.

use crate::{artifacts, Config};
use neuroflow_core::qualifiers::{compare_qualifiers, Compatibility};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::Path;

pub const AXES: &[&str] = &["formats", "space", "resolution", "density", "labelSystem"];

pub fn capabilities() -> Value {
    json!({
        "enforcement": "before-consumer-launch",
        "formats": ["nii", "nii-gz", "json", "bval", "bvec"],
        "resolution": { "formats": ["nii", "nii-gz"], "units": "explicit NIfTI spatial units" },
        "space": ["scanner frame scoped to one content hash", "registered producer provenance", "inputs.* inheritance"],
        "labelSystem": ["registered producer provenance", "inputs.* inheritance"],
        "density": ["registered producer provenance", "inputs.* inheritance"],
        "revisionEquivalence": false,
        "embeddedLabelTables": false,
        "missingInspector": "fail"
    })
}

pub fn qualified(decl: &Value) -> bool {
    AXES.iter().any(|axis| decl.get(axis).is_some())
}

/// Metadata for reusing a hash within one run. Unix change time and file identity
/// also detect replacement or edits that preserve size and modification time.
fn file_stamp(path: &Path) -> Result<Value, String> {
    let meta = fs::metadata(path).map_err(|e| e.to_string())?;
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos());
    let stamp = json!({ "size": meta.len(), "modified": modified });
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let mut stamp = stamp;
        stamp["unix"] = json!({
            "device": meta.dev(),
            "inode": meta.ino(),
            "changed": [meta.ctime(), meta.ctime_nsec()]
        });
        Ok(stamp)
    }
    #[cfg(not(unix))]
    {
        Ok(stamp)
    }
}

fn file_hash(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// The file's SHA-256, reusing this run's evidence while the stamp is unchanged.
/// Without change time, a tool can preserve size and mtime after editing the
/// bytes. Rehash on platforms without that signal or without an mtime.
/// A prior run's record is always rehashed.
fn stamped_hash(
    path: &Path,
    stamp: &Value,
    known: &HashMap<String, Value>,
) -> Result<String, String> {
    match known.get(path.to_string_lossy().as_ref()) {
        Some(seen)
            if stamp.get("unix").is_some()
                && stamp["modified"].is_number()
                && &seen["stamp"] == stamp
                && seen["sha256"].is_string() =>
        {
            Ok(seen["sha256"].as_str().unwrap_or_default().to_string())
        }
        _ => file_hash(path),
    }
}

/// The SHA-256 of a regular file, for provenance checksums.
pub fn content_hash(path: &Path, known: &HashMap<String, Value>) -> Result<String, String> {
    stamped_hash(path, &file_stamp(path)?, known)
}

/// How `tree_hash` digests a directory, stated in provenance so a reader can recompute it.
pub const TREE_HASH_METHOD: &str = "sha256 of the sha256sum manifest (`<sha256>  <path>\\n` per regular file, \
paths relative to the directory with `/` separators, sorted bytewise); symbolic links and other non-regular \
files are skipped";

/// The SHA-256 of a directory tree, per `TREE_HASH_METHOD`. An empty directory
/// hashes the empty manifest. A name that is not UTF-8 is an error, since its
/// manifest line would not be reproducible.
pub fn tree_hash(dir: &Path, known: &HashMap<String, Value>) -> Result<String, String> {
    fn walk(
        dir: &Path,
        rel: &str,
        out: &mut Vec<(String, std::path::PathBuf)>,
    ) -> Result<(), String> {
        for entry in fs::read_dir(dir).map_err(|e| format!("{}: {e}", dir.display()))? {
            let entry = entry.map_err(|e| e.to_string())?;
            let name = entry
                .file_name()
                .into_string()
                .map_err(|n| format!("non-UTF-8 name {n:?}"))?;
            let rel = if rel.is_empty() {
                name
            } else {
                format!("{rel}/{name}")
            };
            let kind = entry.file_type().map_err(|e| e.to_string())?;
            if kind.is_dir() {
                walk(&entry.path(), &rel, out)?;
            } else if kind.is_file() {
                out.push((rel, entry.path()));
            }
        }
        Ok(())
    }
    let mut files = Vec::new();
    walk(dir, "", &mut files)?;
    files.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
    let mut manifest = Sha256::new();
    for (rel, path) in files {
        manifest.update(format!("{}  {rel}\n", content_hash(&path, known)?));
    }
    Ok(format!("{:x}", manifest.finalize()))
}

/// Inspect each element independently. Evidence obtained from an earlier run is
/// useful only while the referenced file still has its recorded content hash.
pub fn inspect(
    cfg: &Config,
    raw: &Value,
    value: &Value,
    known: &HashMap<String, Value>,
) -> Result<Value, String> {
    if let Value::Array(items) = value {
        let evidence: Result<Vec<_>, _> = items
            .iter()
            .enumerate()
            .map(|(i, v)| inspect(cfg, &raw[i], v, known))
            .collect();
        return evidence.map(Value::Array);
    }
    let Some(path) = value.as_str() else {
        return Ok(json!({ "declaration": {} }));
    };
    let path = Path::new(path);
    if !path.is_file() {
        return Ok(
            json!({ "path": path, "declaration": {}, "inspection": { "reason": "no directory-layout inspector" } }),
        );
    }
    let key = path.to_string_lossy().into_owned();
    let stamp = file_stamp(path)?;
    let hash = stamped_hash(path, &stamp, known)?;
    // Missing provenance is not a failure by itself. The consumer's constrained
    // axes decide: without a trusted claim they remain unresolved and `enforce`
    // refuses the launch; an unconstrained consumer proceeds with a `reason`.
    let mut provenance = Value::Null;
    let prior = match raw.as_str() {
        Some(uri) if uri.starts_with("neuroflow://") => {
            match artifacts::qualifier_evidence(cfg, uri) {
                Ok(evidence) => evidence,
                Err(reason) => {
                    provenance = json!({ "reason": reason });
                    Value::Null
                }
            }
        }
        _ => known.get(&key).cloned().unwrap_or(Value::Null),
    };
    if provenance.is_null() {
        // Evidence remembered earlier in this run keeps its lookup outcome.
        provenance = prior.get("provenance").cloned().unwrap_or(Value::Null);
    }
    if !prior.is_null() && prior["sha256"].as_str() != Some(hash.as_str()) {
        return Err(format!(
            "artifact {} changed since its qualifier evidence was recorded",
            path.display()
        ));
    }
    // A reader that rejects the bytes leaves every measurable axis unknown.
    let inspection = artifacts::inspect_qualifiers(path)
        .unwrap_or_else(|reason| json!({ "facts": {}, "inspector": null, "reason": reason }));
    let mut decl = inspection["facts"].clone();
    let mut identity = json!(format!("artifact-sha256:{hash}"));
    // These facts cannot be obtained from an affine, filename, or an integer
    // histogram. Only an executed registry tool may assert their identity.
    if !prior.is_null() {
        for axis in ["space", "density", "labelSystem"] {
            if let Some(v) = prior["declaration"].get(axis) {
                decl[axis] = v.clone();
            }
        }
        identity = prior["spaceIdentity"].clone();
    }
    let mut evidence = json!({ "path": path, "sha256": hash, "stamp": stamp, "declaration": decl,
        "spaceIdentity": identity, "inspection": inspection,
        "producer": prior.get("producer").cloned().unwrap_or(Value::Null) });
    if !provenance.is_null() {
        evidence["provenance"] = provenance;
    }
    Ok(evidence)
}

/// Record every axis checked, including unresolved constraints on failed steps.
/// A target `individual` denotes the frame of this binding, not permission to
/// equate it with another independently supplied image.
pub fn enforce(
    binding: &str,
    target: &Value,
    evidence: &Value,
    checks: &mut Vec<Value>,
) -> Result<(), String> {
    if let Value::Array(items) = evidence {
        for (i, item) in items.iter().enumerate() {
            enforce(&format!("{binding}[{i}]"), target, item, checks)?;
        }
        return Ok(());
    }
    let identity = evidence["spaceIdentity"].as_str();
    let comparisons = compare_qualifiers(&evidence["declaration"], target, identity, identity);
    let mut failure = None;
    let mut details = Vec::new();
    for check in comparisons {
        if check.qualifier != "type" && target.get(&check.qualifier).is_none() {
            continue;
        }
        let resolved = check.outcome == Compatibility::Compatible;
        let detail = serde_json::to_value(&check).map_err(|e| e.to_string())?;
        if !resolved && failure.is_none() {
            let reason = evidence["inspection"]["reason"]
                .as_str()
                .map(|r| format!(" ({r})"))
                .unwrap_or_default();
            failure = Some(format!(
                "{binding}: {} constraint {} (source {}, target {}); {}{}",
                check.qualifier,
                if check.outcome == Compatibility::Incompatible {
                    "violated"
                } else {
                    "unresolved"
                },
                detail["source"],
                detail["target"],
                if check.outcome == Compatibility::Incompatible {
                    "artifact evidence does not meet the requirement"
                } else {
                    "no inspector or trusted provenance establishes this requirement"
                },
                reason
            ));
        }
        details.push(detail);
    }
    // One record per binding: the evidence is stored once beside its checks
    // rather than copied into every axis.
    if !details.is_empty() {
        checks.push(json!({ "binding": binding, "checks": details, "evidence": evidence }));
    }
    failure.map_or(Ok(()), Err)
}

fn uniform(evidence: &Value, key: &str) -> Option<Value> {
    match evidence {
        Value::Array(items) => {
            let first = uniform(items.first()?, key)?;
            items
                .iter()
                .all(|item| uniform(item, key).as_ref() == Some(&first))
                .then_some(first)
        }
        _ if key == "spaceIdentity" => evidence.get(key).filter(|v| !v.is_null()).cloned(),
        _ => evidence["declaration"].get(key).cloned(),
    }
}

/// A successful registered producer establishes semantic claims. Inheritance
/// uses the inspected input, never the input contract's unverified annotations.
pub fn produced(decl: &Value, evidence: &mut Value, inputs: &Map<String, Value>, producer: &Value) {
    if let Value::Array(items) = evidence {
        for item in items {
            produced(decl, item, inputs, producer);
        }
        return;
    }
    evidence["producer"] = producer.clone();
    for axis in AXES {
        let Some(claim) = decl.get(axis) else {
            continue;
        };
        let inherited = claim.as_str().and_then(|s| s.strip_prefix("inputs."));
        if let Some(input) = inherited {
            if let Some(v) = inputs.get(input).and_then(|v| uniform(v, axis)) {
                // Encodings and spacing are read directly. Inherited claims do
                // not overwrite a contradictory physical measurement.
                if !matches!(*axis, "formats" | "resolution") {
                    evidence["declaration"][axis] = v;
                }
            } else if !matches!(*axis, "formats" | "resolution") {
                if let Some(facts) = evidence["declaration"].as_object_mut() {
                    facts.remove(*axis);
                }
            }
            if *axis == "space" {
                evidence["spaceIdentity"] = inputs
                    .get(input)
                    .and_then(|v| uniform(v, "spaceIdentity"))
                    .unwrap_or(Value::Null);
            }
        } else if !matches!(*axis, "formats" | "resolution") {
            evidence["declaration"][axis] = claim.clone();
            if *axis == "space" {
                evidence["spaceIdentity"] =
                    if matches!(claim.as_str(), Some("individual" | "fsnative")) {
                        json!(format!(
                            "producer:{}:{}:{}",
                            producer["run"], producer["step"], producer["output"]
                        ))
                    } else {
                        Value::Null
                    };
            }
        }
    }
}

/// Resolve output inheritance for checking a producer's measurable promises.
pub fn output_requirements(decl: &Value, inputs: &Map<String, Value>) -> Value {
    let mut out = decl.clone();
    for axis in AXES {
        if let Some(input) = decl
            .get(axis)
            .and_then(Value::as_str)
            .and_then(|s| s.strip_prefix("inputs."))
        {
            if let Some(v) = inputs.get(input).and_then(|v| uniform(v, axis)) {
                out[axis] = v;
            }
        }
    }
    out
}

/// Check promises only where a reader measured the property; unresolved facts
/// remain unknown and a downstream consumer requiring them will refuse launch.
pub fn enforce_measured_output(
    binding: &str,
    target: &Value,
    evidence: &Value,
    checks: &mut Vec<Value>,
) -> Result<(), String> {
    if let Value::Array(items) = evidence {
        for (i, item) in items.iter().enumerate() {
            enforce_measured_output(&format!("{binding}[{i}]"), target, item, checks)?;
        }
        return Ok(());
    }
    let mut measurable = json!({});
    for axis in ["formats", "resolution"] {
        if evidence["declaration"].get(axis).is_some()
            && target.get(axis).is_some_and(|v| !v.is_string())
        {
            measurable[axis] = target[axis].clone();
        }
    }
    enforce(binding, &measurable, evidence, checks)
}

pub fn remember(evidence: &Value, known: &mut HashMap<String, Value>) {
    match evidence {
        Value::Array(items) => {
            for item in items {
                remember(item, known);
            }
        }
        _ => {
            if let (Some(path), Some(_)) = (evidence["path"].as_str(), evidence["sha256"].as_str())
            {
                known.insert(path.to_string(), evidence.clone());
            }
        }
    }
}

/// Replay must not return a completed run whose checked inputs or outputs changed.
pub fn unchanged(evidence: &Value) -> bool {
    match evidence {
        Value::Array(items) => items.iter().all(unchanged),
        Value::Object(fields) if fields.contains_key("sha256") => {
            let (Some(path), Some(hash)) = (evidence["path"].as_str(), evidence["sha256"].as_str())
            else {
                return false;
            };
            file_hash(Path::new(path)).is_ok_and(|actual| actual == hash)
        }
        Value::Object(fields) => fields.values().all(unchanged),
        _ => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mutated_artifacts_cannot_reuse_trusted_qualifier_evidence() {
        let root = std::env::temp_dir().join(format!(
            "neuroflow-evidence-cache-{}-{}",
            std::process::id(),
            crate::util::new_run_id()
        ));
        fs::create_dir_all(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        let cfg = Config {
            registry_dirs: Vec::new(),
            spec_dir: None,
            data_roots: vec![root.clone()],
            sessions_root: root.join("runs"),
            interpreters: HashMap::new(),
            step_timeout: None,
            summary_max_bytes: 1024,
            interactive: false,
        };
        let path = root.join("labels.json");
        let value = json!(path);
        for mutation in ["size", "mtime", "preserved-mtime"] {
            fs::write(&path, b"{\"label\":1}").unwrap();
            let original = fs::metadata(&path).unwrap();
            let mut evidence = inspect(&cfg, &value, &value, &HashMap::new()).unwrap();
            produced(
                &json!({ "labelSystem": "atlas@1" }),
                &mut evidence,
                &Map::new(),
                &json!({ "run": "producer", "step": "labels", "output": "labels" }),
            );
            let mut known = HashMap::new();
            remember(&evidence, &mut known);
            let replacement: &[u8] = if mutation == "size" {
                b"{\"label\":222}"
            } else {
                b"{\"label\":2}"
            };
            fs::write(&path, replacement).unwrap();
            let modified = original.modified().unwrap();
            let target_time = if mutation == "mtime" {
                modified + std::time::Duration::from_secs(1)
            } else {
                modified
            };
            fs::File::options()
                .write(true)
                .open(&path)
                .unwrap()
                .set_times(fs::FileTimes::new().set_modified(target_time))
                .unwrap();
            if mutation == "preserved-mtime" {
                let changed = fs::metadata(&path).unwrap();
                assert_eq!(changed.len(), original.len());
                assert_eq!(changed.modified().unwrap(), modified);
            }
            let result = inspect(&cfg, &value, &value, &known);
            assert!(
                result
                    .as_ref()
                    .is_err_and(|error| error.contains("changed since")),
                "{mutation} mutation reused trusted evidence: {result:?}"
            );
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn tree_hash_is_the_sha256sum_manifest_of_regular_files() {
        let root = std::env::temp_dir().join(format!(
            "neuroflow-tree-hash-{}-{}",
            std::process::id(),
            crate::util::new_run_id()
        ));
        let hex = |bytes: &[u8]| format!("{:x}", Sha256::digest(bytes));
        let none = HashMap::new();
        fs::create_dir_all(root.join("empty")).unwrap();
        assert_eq!(tree_hash(&root.join("empty"), &none).unwrap(), hex(b""));

        let dir = root.join("tree");
        fs::create_dir_all(dir.join("sub")).unwrap();
        fs::write(dir.join("b.txt"), "b").unwrap();
        fs::write(dir.join("sub/a.txt"), "a").unwrap();
        fs::write(dir.join("Z.txt"), "z").unwrap();
        let manifest = format!(
            "{}  Z.txt\n{}  b.txt\n{}  sub/a.txt\n",
            hex(b"z"),
            hex(b"b"),
            hex(b"a")
        );
        let hash = tree_hash(&dir, &none).unwrap();
        assert_eq!(hash, hex(manifest.as_bytes()));

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(dir.join("b.txt"), dir.join("link.txt")).unwrap();
            std::os::unix::fs::symlink(dir.join("sub"), dir.join("linkdir")).unwrap();
            assert_eq!(tree_hash(&dir, &none).unwrap(), hash, "links are skipped");
        }
        fs::create_dir(dir.join("hollow")).unwrap();
        assert_eq!(
            tree_hash(&dir, &none).unwrap(),
            hash,
            "empty folders add nothing"
        );

        fs::write(dir.join("sub/a.txt"), "A").unwrap();
        assert_ne!(
            tree_hash(&dir, &none).unwrap(),
            hash,
            "one changed byte changes the hash"
        );
        fs::write(dir.join("sub/a.txt"), "a").unwrap();
        fs::rename(dir.join("sub/a.txt"), dir.join("sub/c.txt")).unwrap();
        assert_ne!(
            tree_hash(&dir, &none).unwrap(),
            hash,
            "a rename changes the hash"
        );
        fs::remove_dir_all(root).unwrap();
    }
}
