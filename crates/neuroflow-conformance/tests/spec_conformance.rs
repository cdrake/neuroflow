//! Checks the core against the vendored spec schemas and examples (tests/spec).
//!
//! The core does not ship a JSON Schema validator; it checks closed key sets
//! (`neuroflow_core::fields`) and semantic rules instead. These tests run
//! `jsonschema` beside it, so a schema change that the core does not follow fails here.

use neuroflow_core::{fields::CLOSED_FIELDS, validate_workflow_value, ValidationReport};
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

const SCHEMA_BASE: &str = "https://niivue.github.io/neuroflow-spec/schemas/0.1/";

fn spec_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/spec")
}

fn read_json(path: &Path) -> Value {
    serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
}

fn schema(file: &str) -> Value {
    read_json(&spec_dir().join("schemas").join(file))
}

fn schema_validator() -> jsonschema::Validator {
    let mut registry = jsonschema::Registry::new();
    for file in ["common.schema.json", "events.schema.json"] {
        registry = registry
            .add(format!("{SCHEMA_BASE}{file}"), schema(file))
            .unwrap();
    }
    let registry = registry.prepare().unwrap();
    jsonschema::options()
        .with_registry(&registry)
        .build(&schema("workflow.schema.json"))
        .unwrap()
}

fn schema_errors(validator: &jsonschema::Validator, document: &Value) -> Vec<String> {
    validator
        .iter_errors(document)
        .map(|e| format!("{}: {e}", e.instance_path()))
        .collect()
}

/// The property names a closed schema declaration allows. A `oneOf` of closed
/// objects (a binding) allows the union of its branches.
fn schema_fields(reference: &str) -> BTreeSet<String> {
    let (file, pointer) = reference.split_once('#').unwrap();
    let document = schema(file);
    let declaration = document
        .pointer(pointer)
        .unwrap_or_else(|| panic!("{reference}"));
    let branches = match declaration.get("oneOf").and_then(Value::as_array) {
        Some(branches) => branches.iter().collect(),
        None => vec![declaration],
    };
    let mut fields = BTreeSet::new();
    for branch in branches {
        assert_eq!(
            branch["additionalProperties"],
            json!(false),
            "{reference} is not closed"
        );
        fields.extend(branch["properties"].as_object().unwrap().keys().cloned());
    }
    fields
}

#[test]
fn closed_fields_follow_the_schema() {
    for (reference, fields) in CLOSED_FIELDS {
        let expected = schema_fields(reference);
        let actual: BTreeSet<String> = fields.iter().map(|f| f.to_string()).collect();
        assert_eq!(actual, expected, "{reference}");
    }
}

/// Closed declarations a workflow document cannot contain: runtime event payloads
/// and the tool-side event declarations.
const NOT_IN_A_WORKFLOW: &[&str] = &[
    "events.schema.json#/$defs/envelope",
    "events.schema.json#/$defs/statusPayload",
    "events.schema.json#/$defs/progressPayload",
    "events.schema.json#/$defs/logPayload",
    "events.schema.json#/$defs/heartbeatPayload",
    "events.schema.json#/$defs/contextWritePayload",
    "events.schema.json#/$defs/outputPayload",
    "events.schema.json#/$defs/errorPayload",
    "events.schema.json#/$defs/itemErrorPayload",
    "events.schema.json#/$defs/cancelRequestPayload",
    "events.schema.json#/$defs/fixProposalPayload",
    "events.schema.json#/$defs/fixProposalPayload/properties/targets/items",
    "events.schema.json#/$defs/fixOperation",
    "events.schema.json#/$defs/awaitApprovalPayload",
    "events.schema.json#/$defs/toolEventsDecl",
    "events.schema.json#/$defs/emittedEventDecl",
];

fn closed_declarations(file: &str, pointer: String, value: &Value, found: &mut Vec<String>) {
    match value {
        Value::Object(object) => {
            if object.get("additionalProperties") == Some(&json!(false)) {
                // A binding's `oneOf` branches are checked as one declaration.
                let reference = format!("{file}#{pointer}");
                found.push(match reference.split_once("/oneOf/") {
                    Some((declaration, _)) => declaration.to_string(),
                    None => reference,
                });
            }
            for (key, child) in object {
                closed_declarations(file, format!("{pointer}/{key}"), child, found);
            }
        }
        Value::Array(items) => {
            for (index, child) in items.iter().enumerate() {
                closed_declarations(file, format!("{pointer}/{index}"), child, found);
            }
        }
        _ => {}
    }
}

#[test]
fn every_closed_declaration_is_checked() {
    let mut found = Vec::new();
    for file in [
        "workflow.schema.json",
        "common.schema.json",
        "events.schema.json",
    ] {
        closed_declarations(file, String::new(), &schema(file), &mut found);
    }
    let found: BTreeSet<String> = found.into_iter().collect();
    let covered: BTreeSet<String> = CLOSED_FIELDS
        .iter()
        .map(|(reference, _)| reference.to_string())
        .chain(NOT_IN_A_WORKFLOW.iter().map(|r| r.to_string()))
        .collect();
    assert_eq!(found, covered);
}

fn examples(dir: &str) -> Vec<(String, Value)> {
    let mut documents: Vec<(String, Value)> = fs::read_dir(spec_dir().join(dir))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .map(|path| {
            (
                path.file_name().unwrap().to_string_lossy().into_owned(),
                read_json(&path),
            )
        })
        .collect();
    documents.sort_by(|a, b| a.0.cmp(&b.0));
    assert!(!documents.is_empty(), "no examples in {dir}");
    documents
}

fn errors(report: &ValidationReport) -> Vec<&str> {
    report
        .issues
        .iter()
        .filter(|issue| issue.severity == "error")
        .map(|issue| issue.message.as_str())
        .collect()
}

#[test]
fn valid_examples_pass_the_core_and_the_schema() {
    let validator = schema_validator();
    for (name, document) in examples("examples") {
        assert_eq!(
            schema_errors(&validator, &document),
            Vec::<String>::new(),
            "{name}"
        );
        let report = validate_workflow_value(&document);
        assert!(report.ok, "{name}: {:?}", report.issues);
    }
}

#[test]
fn invalid_examples_fail_the_core_and_the_schema() {
    let validator = schema_validator();
    for (name, document) in examples("examples/invalid") {
        let schema_errors = schema_errors(&validator, &document);
        let report = validate_workflow_value(&document);
        match name.as_str() {
            // The schema does not gate fields by `neuroflow` version; the core and
            // the spec's own harness (tests/validate.mjs) apply that rule.
            "bad-output-version.json" | "bad-context-qualifier-version.json" => {
                assert!(schema_errors.is_empty(), "{name}: {schema_errors:?}");
                assert!(!report.ok, "{name}");
            }
            // Spec §27.5: a reference validator may report an unrecognized stage
            // as a warning, and must not then fail the document on stage alone.
            "bad-stage.json" => {
                assert!(!schema_errors.is_empty(), "{name}");
                assert!(report.ok, "{name}: {:?}", report.issues);
                assert!(report.issues.iter().any(|issue| {
                    issue.severity == "warning"
                        && issue.path.as_deref() == Some("steps.convert.stage")
                }));
            }
            _ => {
                assert!(!schema_errors.is_empty(), "{name}: the schema accepts it");
                assert!(!report.ok, "{name}: the core accepts it");
            }
        }
    }
}

/// Shared with tests/ui/unknownFields.test.ts.
#[test]
fn unknown_fields_fail_at_every_closed_declaration() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../neuroflow-core/tests/fixtures/unknown-fields.json"
    ))
    .unwrap();
    let validator = schema_validator();
    let base = &fixture["base"];
    assert_eq!(schema_errors(&validator, base), Vec::<String>::new());
    assert_eq!(errors(&validate_workflow_value(base)), Vec::<&str>::new());

    for case in fixture["cases"].as_array().unwrap() {
        let mut document = base.clone();
        let mut target = &mut document;
        for key in case["at"].as_array().unwrap() {
            target = match key {
                Value::Number(index) => &mut target[index.as_u64().unwrap() as usize],
                key => &mut target[key.as_str().unwrap()],
            };
        }
        target["unknownField"] = json!(true);

        let path = case["path"].as_str().unwrap();
        assert!(
            !schema_errors(&validator, &document).is_empty(),
            "{path}: the schema accepts it"
        );
        let unknown: Vec<_> = validate_workflow_value(&document)
            .issues
            .into_iter()
            .filter(|issue| issue.code.as_deref() == Some("unknown-field"))
            .map(|issue| (issue.severity, issue.path.unwrap_or_default()))
            .collect();
        assert_eq!(unknown, vec![("error".to_string(), path.to_string())]);
    }
}

#[test]
fn unknown_field_names_the_closest_field() {
    let mut document =
        read_json(&spec_dir().join("examples/optional-workflow-output.neuroflow.json"));
    let output = document["outputs"]
        .as_object_mut()
        .unwrap()
        .values_mut()
        .next()
        .unwrap();
    output["optinal"] = json!(true);
    let issue = validate_workflow_value(&document)
        .issues
        .into_iter()
        .find(|issue| issue.code.as_deref() == Some("unknown-field"))
        .unwrap();
    assert_eq!(issue.message, "Unknown field optinal.");
    assert_eq!(issue.hint.as_deref(), Some("Did you mean optional?"));
}

#[test]
fn explained_output_fields_are_reported_once() {
    let document = read_json(&spec_dir().join("examples/invalid/bad-output-default.json"));
    let report = validate_workflow_value(&document);
    assert!(report
        .issues
        .iter()
        .all(|issue| issue.code.as_deref() != Some("unknown-field")));
    assert!(!report.ok);
}
