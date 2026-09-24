//! NeuroFlow type declarations to MCP JSON Schema (RFC 0009 sections 1.2 and 1.3).

use serde_json::{json, Map, Value};

/// Closed-vocabulary types passed and returned as references to files or directories.
const ARTIFACT_TYPES: &[&str] = &[
    "core:file",
    "core:directory",
    "core:tabular",
    "neuro:volume",
    "neuro:mask",
    "neuro:dicom-folder",
    "neuro:bids-dataset",
    "neuro:label-map",
    "neuro:transform",
    "neuro:surface",
    "neuro:tract",
    "neuro:ome-zarr",
    "neuro:ngff-zarr",
    "neuro:statmap",
    "neuro:probseg",
    "neuro:cifti",
    "neuro:gradient-table",
    "neuro:connectivity-matrix",
    "neuro:report",
    "bids:sidecar",
    "bids:participants-table",
    "bids:events-table",
    "bids:scans-table",
    "bids:sessions-table",
    "bids:derivatives-dataset",
];

const CLOSED_NAMESPACES: &[&str] = &["core", "neuro", "bids", "prov"];

/// Types whose values are directories rather than single files.
pub fn is_directory_type(t: &str) -> bool {
    matches!(
        t,
        "core:directory"
            | "neuro:dicom-folder"
            | "neuro:bids-dataset"
            | "bids:derivatives-dataset"
            | "neuro:ome-zarr"
    )
}

pub fn element_type(t: &str) -> &str {
    neuroflow_core::array_element_type(t).unwrap_or(t)
}

pub fn is_array_type(t: &str) -> bool {
    neuroflow_core::array_element_type(t).is_some()
}

/// Whether values of type `t` travel as artifact references (paths / URIs).
/// `value_types` lists extension types a tool declares as inline JSON values.
pub fn is_artifact_type(t: &str, value_types: &[String]) -> bool {
    let t = element_type(t);
    if ARTIFACT_TYPES.contains(&t) {
        return true;
    }
    let namespace = t.split(':').next().unwrap_or("");
    if CLOSED_NAMESPACES.contains(&namespace) {
        return false;
    }
    !value_types.iter().any(|v| v == t)
}

/// `extensions["neuroflow/mcp"].valueTypes` for a document.
pub fn value_types_of(doc: &Value) -> Vec<String> {
    doc.pointer("/extensions/neuroflow~1mcp/valueTypes")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn artifact_ref_schema() -> Value {
    json!({
        "type": "string",
        "description": "A neuroflow:// artifact URI returned by an earlier call, or an absolute path inside one of the server's allowed data roots."
    })
}

fn scalar_schema(t: &str, value_types: &[String]) -> Value {
    if is_artifact_type(t, value_types) {
        return artifact_ref_schema();
    }
    match t {
        "core:string" => json!({ "type": "string" }),
        "core:number" => json!({ "type": "number" }),
        "core:integer" => json!({ "type": "integer" }),
        "core:boolean" => json!({ "type": "boolean" }),
        "core:object" => json!({ "type": "object" }),
        "core:json" => json!({}),
        _ => json!({ "type": "object" }),
    }
}

/// JSON Schema for one NeuroFlow type declaration.
pub fn declaration_schema(decl: &Value, value_types: &[String]) -> Value {
    let t = decl.get("type").and_then(Value::as_str).unwrap_or("core:json");
    let mut schema = match neuroflow_core::array_element_type(t) {
        Some(inner) => json!({ "type": "array", "items": scalar_schema(inner, value_types) }),
        None => scalar_schema(t, value_types),
    };
    let obj = schema.as_object_mut().expect("schema is an object");

    let mut description = decl
        .get("description")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if is_artifact_type(t, value_types) {
        let hint = if is_array_type(t) {
            " Each item: a neuroflow:// artifact URI or an absolute path inside an allowed data root."
        } else {
            " Pass a neuroflow:// artifact URI or an absolute path inside an allowed data root."
        };
        description.push_str(hint);
        obj.remove("description");
    }
    if !description.is_empty() {
        obj.insert("description".into(), Value::String(description.trim().to_string()));
    }
    if let Some(label) = decl.get("label") {
        obj.insert("title".into(), label.clone());
    }
    for (from, to) in [("default", "default"), ("enum", "enum"), ("min", "minimum"), ("max", "maximum")] {
        if let Some(v) = decl.get(from) {
            obj.insert(to.into(), v.clone());
        }
    }
    obj.insert("x-neuroflow-type".into(), Value::String(t.to_string()));
    schema
}

pub fn is_required(decl: &Value) -> bool {
    !decl.get("optional").and_then(Value::as_bool).unwrap_or(false) && decl.get("default").is_none()
}

/// `inputSchema` for a tool or workflow from its declared `inputs`.
pub fn input_schema(inputs: Option<&Map<String, Value>>, value_types: &[String]) -> Value {
    let mut properties = Map::new();
    let mut required = Vec::new();
    for (name, decl) in inputs.into_iter().flatten() {
        properties.insert(name.clone(), declaration_schema(decl, value_types));
        if is_required(decl) {
            required.push(Value::String(name.clone()));
        }
    }
    let mut schema = json!({
        "type": "object",
        "properties": properties,
        "additionalProperties": false
    });
    if !required.is_empty() {
        schema["required"] = Value::Array(required);
    }
    schema
}

/// `outputSchema` shared by every run-producing tool (RFC 0009 section 1.4).
pub fn run_output_schema() -> Value {
    json!({
        "type": "object",
        "required": ["runId", "status"],
        "properties": {
            "runId": { "type": "string" },
            "status": {
                "type": "string",
                "enum": ["completed", "partial", "failed", "halted", "cancelled", "in-progress"]
            },
            "outputs": {
                "type": "object",
                "description": "Public outputs. Artifact-typed outputs are descriptors (uri, type, path, mediaType, bytes); value-typed outputs are inline JSON."
            },
            "provenance": { "type": "string", "description": "neuroflow:// URI of the run's provenance document." },
            "failedStep": { "type": "string" },
            "error": { "type": "string" },
            "logs": { "type": "object" }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_types() {
        assert!(is_artifact_type("neuro:volume", &[]));
        assert!(is_artifact_type("core:array<neuro:volume>", &[]));
        assert!(!is_artifact_type("neuro:qc-metrics", &[]));
        assert!(!is_artifact_type("core:string", &[]));
        assert!(is_artifact_type("neurovue:correction-patch", &[]));
        assert!(!is_artifact_type(
            "neurovue:correction-patch",
            &["neurovue:correction-patch".to_string()]
        ));
    }

    #[test]
    fn builds_input_schema() {
        let inputs = json!({
            "bids_dir": { "type": "neuro:bids-dataset", "description": "Dataset." },
            "operation": { "type": "core:string", "optional": true, "default": "smooth", "enum": ["smooth", "zscore"] },
            "amount": { "type": "core:number", "optional": true, "default": 3, "min": 0 }
        });
        let schema = input_schema(inputs.as_object(), &[]);
        assert_eq!(schema["required"], json!(["bids_dir"]));
        assert_eq!(schema["properties"]["bids_dir"]["type"], "string");
        assert_eq!(schema["properties"]["bids_dir"]["x-neuroflow-type"], "neuro:bids-dataset");
        assert_eq!(schema["properties"]["operation"]["enum"], json!(["smooth", "zscore"]));
        assert_eq!(schema["properties"]["amount"]["minimum"], 0);
    }
}
