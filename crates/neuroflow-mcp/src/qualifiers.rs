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
        "formats": ["nii", "nii-gz", "json"],
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
    let hash = file_hash(path)?;
    let prior = match raw.as_str() {
        Some(uri) if uri.starts_with("neuroflow://") => artifacts::qualifier_evidence(cfg, uri)?,
        _ => known
            .get(&path.to_string_lossy().into_owned())
            .cloned()
            .unwrap_or(Value::Null),
    };
    if !prior.is_null() && prior["sha256"].as_str() != Some(hash.as_str()) {
        return Err(format!(
            "artifact {} changed since its qualifier evidence was recorded",
            path.display()
        ));
    }
    let inspection = artifacts::inspect_qualifiers(path)?;
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
    Ok(json!({ "path": path, "sha256": hash, "declaration": decl,
        "spaceIdentity": identity, "inspection": inspection,
        "producer": prior.get("producer").cloned().unwrap_or(Value::Null) }))
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
    for check in comparisons {
        if check.qualifier != "type" && target.get(&check.qualifier).is_none() {
            continue;
        }
        let resolved = check.outcome == Compatibility::Compatible;
        let detail = serde_json::to_value(&check).map_err(|e| e.to_string())?;
        if !resolved && failure.is_none() {
            failure = Some(format!(
                "{binding}: {} constraint {} (source {}, target {}); {}",
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
                }
            ));
        }
        checks.push(json!({ "binding": binding, "check": detail, "evidence": evidence }));
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
