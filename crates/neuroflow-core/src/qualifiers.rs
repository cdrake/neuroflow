//! RFC 0010 declaration comparison. Identity is provenance supplied by a caller,
//! never inferred from an affine, filename, or the word `individual`.
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::HashSet;

use crate::{array_element_type, error, is_type_compatible, ValidationIssue, TYPE_QUALIFIERS};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Compatibility {
    Compatible,
    Incompatible,
    RequiresRuntimeCheck,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QualifierCheck {
    pub qualifier: String,
    pub outcome: Compatibility,
    pub source: Value,
    pub target: Value,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResolvedQualifiers {
    pub declaration: Value,
    pub space_identity: Option<String>,
}

fn parent(format: &str) -> Option<&'static str> {
    match format {
        "nii" | "nii-gz" | "nii-pair" => Some("nifti"),
        "mgz" => Some("mgh"),
        "seg-nrrd" => Some("nrrd"),
        "dicom-seg" => Some("dicom"),
        "cifti-dtseries" | "cifti-dscalar" | "cifti-dlabel" | "cifti-dconn" | "cifti-pconn"
        | "cifti-ptseries" | "cifti-pscalar" => Some("cifti"),
        "dseg-tsv" => Some("tsv"),
        _ => None,
    }
}

fn accepted(source: &str, target: &str) -> bool {
    source == target || parent(source).is_some_and(|p| accepted(p, target))
}

fn formats(value: &Value) -> Option<Vec<&str>> {
    let values = value.as_array()?;
    if values.is_empty() {
        return None;
    }
    values.iter().map(Value::as_str).collect()
}

fn spacing(value: &Value) -> Option<[f64; 3]> {
    if let Some(number) = value.as_f64().filter(|n| n.is_finite() && *n > 0.0) {
        return Some([number; 3]);
    }
    let values = value.as_array()?;
    if values.len() != 3 {
        return None;
    }
    let numbers: Vec<f64> = values.iter().map(Value::as_f64).collect::<Option<_>>()?;
    numbers
        .iter()
        .all(|n| n.is_finite() && *n > 0.0)
        .then(|| [numbers[0], numbers[1], numbers[2]])
}

fn identity_label(value: &str) -> (&str, Option<&str>) {
    // A table URL is an exact identity, including any @ in its URL path.
    if value.starts_with("https://") || value.starts_with("http://") {
        return (value, None);
    }
    value
        .split_once('@')
        .map_or((value, None), |(id, version)| (id, Some(version)))
}

fn compare_axis(
    axis: &str,
    source: &Value,
    target: &Value,
    source_identity: Option<&str>,
    target_identity: Option<&str>,
) -> Compatibility {
    use Compatibility::*;
    if target.is_null() {
        return Compatible;
    }
    if source.is_null()
        || source.as_str().is_some_and(|v| v.starts_with("inputs."))
        || target.as_str().is_some_and(|v| v.starts_with("inputs."))
    {
        return RequiresRuntimeCheck;
    }
    match axis {
        "formats" => {
            let (Some(source), Some(target)) = (formats(source), formats(target)) else {
                return RequiresRuntimeCheck;
            };
            if source.iter().all(|s| target.iter().any(|t| accepted(s, t))) {
                Compatible
            } else if source
                .iter()
                .all(|s| target.iter().all(|t| !accepted(s, t) && !accepted(t, s)))
            {
                Incompatible
            } else {
                RequiresRuntimeCheck
            }
        }
        "resolution" => {
            let (Some(source), Some(target)) = (spacing(source), spacing(target)) else {
                return RequiresRuntimeCheck;
            };
            if source
                .iter()
                .zip(target)
                .all(|(s, t)| (s - t).abs() < 0.001)
            {
                Compatible
            } else {
                Incompatible
            }
        }
        "space" | "labelSystem" => {
            let (Some(source), Some(target)) = (source.as_str(), target.as_str()) else {
                return RequiresRuntimeCheck;
            };
            let ((source_name, source_revision), (target_name, target_revision)) =
                (identity_label(source), identity_label(target));
            if source_name != target_name {
                return if axis == "labelSystem"
                    && (source_name == "embedded" || target_name == "embedded")
                {
                    RequiresRuntimeCheck
                } else {
                    Incompatible
                };
            }
            if target_revision.is_some() && source_revision != target_revision {
                return RequiresRuntimeCheck;
            }
            if axis == "space"
                && matches!(source_name, "individual" | "fsnative")
                && (source_identity.is_none() || source_identity != target_identity)
            {
                return RequiresRuntimeCheck;
            }
            Compatible
        }
        "density" => {
            if source == target {
                Compatible
            } else {
                Incompatible
            }
        }
        _ => RequiresRuntimeCheck,
    }
}

/// Compare already-resolved declarations. Subject identities must denote the
/// acquisition/output that owns a frame, not a matching geometry or subject name.
/// A tool's ordinary `individual` input describes the value bound to that input;
/// the caller may give it that binding's provenance identity. Comparisons between
/// distinct values must retain their distinct identities.
pub fn compare_qualifiers(
    source: &Value,
    target: &Value,
    source_identity: Option<&str>,
    target_identity: Option<&str>,
) -> Vec<QualifierCheck> {
    let mut checks = Vec::new();
    if let (Some(s), Some(t)) = (
        source.get("type").and_then(Value::as_str),
        target.get("type").and_then(Value::as_str),
    ) {
        if !is_type_compatible(s, t) {
            checks.push(QualifierCheck {
                qualifier: "type".into(),
                outcome: Compatibility::Incompatible,
                source: json!(s),
                target: json!(t),
                message: format!("type is incompatible: source {s}, target {t}."),
            });
            return checks;
        }
    }
    for axis in TYPE_QUALIFIERS {
        let source = source.get(*axis).cloned().unwrap_or(Value::Null);
        let target = target.get(*axis).cloned().unwrap_or(Value::Null);
        let outcome = compare_axis(axis, &source, &target, source_identity, target_identity);
        let status = match outcome {
            Compatibility::Compatible => "is compatible",
            Compatibility::Incompatible => "is incompatible",
            Compatibility::RequiresRuntimeCheck => "requires a runtime check",
        };
        checks.push(QualifierCheck {
            qualifier: (*axis).into(),
            outcome,
            message: format!("{axis} {status}: source {source}, target {target}."),
            source,
            target,
        });
    }
    checks
}

pub(crate) fn tool<'a>(tools: &'a Value, reference: &str) -> Option<&'a Value> {
    let (id, version) = reference
        .rsplit_once('@')
        .map_or((reference, None), |(id, version)| (id, Some(version)));
    tools.as_array()?.iter().rev().find(|tool| {
        (tool.get("id").and_then(Value::as_str) == Some(id)
            || tool.get("name").and_then(Value::as_str) == Some(id))
            && version
                .is_none_or(|version| tool.get("version").and_then(Value::as_str) == Some(version))
    })
}

/// Resolve inherited output qualifiers through the actual workflow bindings.
/// Missing declarations, constants and cycles remain unknown. A context field is
/// mutable, so its declaration alone never proves a subject frame identity.
pub fn resolve_qualifiers(reference: &str, workflow: &Value, tools: &Value) -> ResolvedQualifiers {
    fn resolve(
        reference: &str,
        workflow: &Value,
        tools: &Value,
        visiting: &mut HashSet<String>,
    ) -> ResolvedQualifiers {
        let unknown = || ResolvedQualifiers {
            declaration: json!({}),
            space_identity: None,
        };
        if !visiting.insert(reference.to_string()) {
            return unknown();
        }
        let parts: Vec<_> = reference.split('.').collect();
        let (declaration, step) = match parts.as_slice() {
            ["inputs", name] => (workflow.get("inputs").and_then(|v| v.get(*name)), None),
            ["context", name] => (
                workflow
                    .get("context")
                    .and_then(|v| v.get("fields"))
                    .and_then(|v| v.get(*name)),
                None,
            ),
            ["steps", name, "outputs", output] => {
                let step = workflow.get("steps").and_then(|v| v.get(*name));
                let declaration = step
                    .and_then(|s| s.get("tool"))
                    .and_then(Value::as_str)
                    .and_then(|id| tool(tools, id))
                    .and_then(|t| t.get("outputs"))
                    .and_then(|o| o.get(*output));
                (declaration, step)
            }
            _ => (None, None),
        };
        let Some(mut declaration) = declaration.and_then(Value::as_object).cloned() else {
            visiting.remove(reference);
            return unknown();
        };
        let mut space_identity = (!reference.starts_with("context.")
            && declaration.contains_key("space"))
        .then(|| reference.to_string());
        for axis in TYPE_QUALIFIERS {
            let input = declaration
                .get(*axis)
                .and_then(Value::as_str)
                .and_then(|v| v.strip_prefix("inputs."))
                .map(str::to_owned);
            if let Some(input) = input {
                let inherited = step
                    .and_then(|s| s.get("inputs"))
                    .and_then(|v| v.get(&input))
                    .and_then(|v| v.get("ref"))
                    .and_then(Value::as_str)
                    .map(|r| resolve(r, workflow, tools, visiting))
                    .unwrap_or_else(unknown);
                if let Some(value) = inherited.declaration.get(*axis) {
                    declaration.insert((*axis).into(), value.clone());
                } else {
                    declaration.remove(*axis);
                }
                if *axis == "space" {
                    space_identity = inherited.space_identity;
                }
            }
        }
        visiting.remove(reference);
        ResolvedQualifiers {
            declaration: Value::Object(declaration),
            space_identity,
        }
    }
    resolve(reference, workflow, tools, &mut HashSet::new())
}

fn allowed(axis: &str, data_type: &str) -> bool {
    let t = array_element_type(data_type).unwrap_or(data_type);
    let namespace = t.split(':').next().unwrap_or("");
    if !["core", "neuro", "bids", "prov"].contains(&namespace) {
        return true;
    }
    if [
        "core:string",
        "core:number",
        "core:integer",
        "core:boolean",
        "core:object",
        "core:json",
    ]
    .contains(&t)
    {
        return false;
    }
    match axis {
        "formats" => true,
        "space" => [
            "neuro:volume",
            "neuro:mask",
            "neuro:label-map",
            "neuro:statmap",
            "neuro:probseg",
            "neuro:surface",
            "neuro:tract",
            "neuro:cifti",
        ]
        .contains(&t),
        "resolution" => [
            "neuro:volume",
            "neuro:mask",
            "neuro:label-map",
            "neuro:statmap",
            "neuro:probseg",
        ]
        .contains(&t),
        "density" => ["neuro:surface", "neuro:cifti"].contains(&t),
        "labelSystem" => ["neuro:label-map", "neuro:probseg"].contains(&t),
        _ => false,
    }
}

fn local_id(value: &str) -> bool {
    value.as_bytes().first().is_some_and(u8::is_ascii_lowercase)
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}

fn label(value: &str, format: bool, revision: bool) -> bool {
    let (name, suffix) = value
        .split_once('@')
        .map_or((value, None), |(name, revision)| (name, Some(revision)));
    if let Some(suffix) = suffix {
        if !revision
            || !suffix
                .as_bytes()
                .first()
                .is_some_and(u8::is_ascii_alphanumeric)
            || !suffix
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
        {
            return false;
        }
    }
    let name = if let Some((vendor, name)) = name.split_once(':') {
        if ["core", "neuro", "bids", "prov"].contains(&vendor)
            || !vendor
                .as_bytes()
                .first()
                .is_some_and(u8::is_ascii_lowercase)
            || !vendor
                .bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || b".-".contains(&c))
        {
            return false;
        }
        name
    } else {
        name
    };
    if format {
        name.as_bytes().first().is_some_and(u8::is_ascii_lowercase)
            && name
                .bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
    } else {
        name.as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
            && name
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
    }
}

fn valid_value(axis: &str, value: &Value) -> bool {
    match axis {
        "formats" => formats(value).is_some_and(|values| {
            values.iter().all(|v| label(v, true, false))
                && values.iter().collect::<HashSet<_>>().len() == values.len()
        }),
        "resolution" => spacing(value).is_some(),
        "space" | "density" | "labelSystem" => value.as_str().is_some_and(|v| {
            label(v, false, axis != "density")
                || (axis == "labelSystem"
                    && (v.starts_with("https://") || v.starts_with("http://"))
                    && !v.chars().any(char::is_whitespace)
                    && v.split_once("://")
                        .is_some_and(|(_, host)| !host.is_empty()))
        }),
        _ => false,
    }
}

/// Semantic rules supplement schema validation, including inherited references
/// and the required 0.1.1 envelope. Call this for standalone tools as well.
pub fn validate_document_qualifiers(document: &Value) -> Vec<ValidationIssue> {
    let mut issues = Vec::new();
    let is_tool = document.get("kind").and_then(Value::as_str) == Some("tool");
    let inputs = document.get("inputs").and_then(Value::as_object);
    let empty = Map::new();
    for (section, declarations) in [
        ("inputs", inputs.unwrap_or(&empty)),
        (
            "outputs",
            document
                .get("outputs")
                .and_then(Value::as_object)
                .unwrap_or(&empty),
        ),
        (
            "context.fields",
            document
                .get("context")
                .and_then(|v| v.get("fields"))
                .and_then(Value::as_object)
                .unwrap_or(&empty),
        ),
    ] {
        for (name, declaration) in declarations {
            for axis in TYPE_QUALIFIERS {
                let Some(value) = declaration.get(*axis) else {
                    continue;
                };
                let path = format!("{section}.{name}.{axis}");
                if document.get("neuroflow").and_then(Value::as_str) != Some("0.1.1") {
                    issues.push(error(&path, "Type qualifiers require neuroflow 0.1.1."));
                }
                let t = declaration
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if !allowed(axis, t) {
                    issues.push(error(&path, format!("{axis} is not allowed on {t}.")));
                }
                if let Some(input) = value.as_str().and_then(|v| v.strip_prefix("inputs.")) {
                    if !is_tool || section != "outputs" || !local_id(input) {
                        issues.push(error(&path, "Qualifier inheritance is allowed only on tool outputs as inputs.<local-id>."));
                    }
                    match inputs.and_then(|inputs| inputs.get(input)) {
                        None => issues.push(error(
                            &path,
                            format!("Qualifier references undeclared input {input}."),
                        )),
                        Some(source) => {
                            if !source
                                .get("type")
                                .and_then(Value::as_str)
                                .is_some_and(|t| allowed(axis, t))
                            {
                                issues.push(error(
                                    &path,
                                    format!("Input {input} cannot carry {axis}."),
                                ));
                            }
                        }
                    }
                } else if !valid_value(axis, value) {
                    issues.push(error(
                        &path,
                        format!("Invalid {axis} qualifier value {value}."),
                    ));
                }
            }
        }
    }
    issues
}
