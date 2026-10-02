use neuroflow_core::{
    qualifiers::{
        compare_qualifiers, resolve_qualifiers, validate_document_qualifiers, Compatibility,
    },
    validate_workflow_value_with_tools,
};
use serde_json::{json, Value};

#[test]
fn rfc_conformance_shared_with_typescript() {
    let cases: Vec<Value> = serde_json::from_str(include_str!("fixtures/qualifiers.json")).unwrap();
    for case in cases {
        let checks = compare_qualifiers(
            &case["source"],
            &case["target"],
            case["sourceIdentity"].as_str(),
            case["targetIdentity"].as_str(),
        );
        let outcome = if checks
            .iter()
            .any(|c| c.outcome == Compatibility::Incompatible)
        {
            Compatibility::Incompatible
        } else if checks
            .iter()
            .any(|c| c.outcome == Compatibility::RequiresRuntimeCheck)
        {
            Compatibility::RequiresRuntimeCheck
        } else {
            Compatibility::Compatible
        };
        assert_eq!(
            serde_json::to_value(outcome).unwrap(),
            case["outcome"],
            "{}: {checks:?}",
            case["name"]
        );
    }
}

fn graph() -> (Value, Value) {
    (
        json!({
            "neuroflow":"0.1.1", "kind":"workflow", "id":"test/chain", "version":"1.0.0", "description":"Chain",
            "inputs":{"t1":{"type":"neuro:volume", "formats":["nii-gz"], "space":"individual", "resolution":1}},
            "steps":{
                "a":{"tool":"test/pass", "inputs":{"image":{"ref":"inputs.t1"}}},
                "b":{"tool":"test/pass", "inputs":{"image":{"ref":"steps.a.outputs.image"}}}
            },
            "outputs":{"image":{"type":"neuro:volume", "formats":["nifti"], "ref":"steps.b.outputs.image"}}
        }),
        json!([{
            "neuroflow":"0.1.1", "kind":"tool", "id":"test/pass", "inputs":{"image":{"type":"neuro:volume", "formats":["nifti"], "space":"individual"}},
            "outputs":{"image":{"type":"neuro:volume", "formats":"inputs.image", "space":"inputs.image", "resolution":"inputs.image"}}
        }]),
    )
}

#[test]
fn inherited_qualifiers_follow_bindings_and_preserve_acquisition() {
    let (workflow, tools) = graph();
    let result = resolve_qualifiers("steps.b.outputs.image", &workflow, &tools);
    assert_eq!(result.declaration["formats"], json!(["nii-gz"]));
    assert_eq!(result.declaration["resolution"], json!(1));
    assert_eq!(result.space_identity.as_deref(), Some("inputs.t1"));
    let report = validate_workflow_value_with_tools(&workflow, Some(&tools));
    assert!(report.ok && report.issues.is_empty(), "{report:?}");
}

#[test]
fn unknown_values_constants_and_cycles_never_prove_qualifiers() {
    let (mut workflow, tools) = graph();
    workflow["inputs"]["t1"] = json!({"type":"neuro:volume"});
    let resolved = resolve_qualifiers("steps.b.outputs.image", &workflow, &tools);
    assert!(resolved.declaration.get("formats").is_none());
    assert!(resolved.space_identity.is_none());
    let report = validate_workflow_value_with_tools(&workflow, Some(&tools));
    assert!(
        report.ok
            && report
                .issues
                .iter()
                .any(|i| i.message.contains("requires a runtime check"))
    );
    workflow["steps"]["a"]["inputs"]["image"] = json!({"constant":"T1.nii.gz"});
    let report = validate_workflow_value_with_tools(&workflow, Some(&tools));
    assert!(report
        .issues
        .iter()
        .any(|i| i.path.as_deref() == Some("steps.a.inputs.image")
            && i.message.contains("requires a runtime check")));
    workflow["steps"]["a"]["inputs"]["image"] = json!({"ref":"steps.b.outputs.image"});
    let result = resolve_qualifiers("steps.b.outputs.image", &workflow, &tools);
    assert!(result.space_identity.is_none());
    assert!(result.declaration.get("formats").is_none());
}

#[test]
fn incompatible_bindings_and_workflow_outputs_fail_validation() {
    let (mut workflow, tools) = graph();
    workflow["inputs"]["t1"]["formats"] = json!(["mgz"]);
    let report = validate_workflow_value_with_tools(&workflow, Some(&tools));
    assert!(!report.ok);
    assert!(report
        .issues
        .iter()
        .any(|i| i.path.as_deref() == Some("steps.a.inputs.image")
            && i.message.contains("formats is incompatible")));
    assert!(report
        .issues
        .iter()
        .any(|i| i.path.as_deref() == Some("outputs.image.ref")
            && i.message.contains("formats is incompatible")));
}

#[test]
fn semantic_document_rules_reject_unsupported_claims() {
    let (_, tools) = graph();
    let mut doc = tools[0].clone();
    assert!(validate_document_qualifiers(&doc).is_empty());
    doc["neuroflow"] = json!("0.1.0");
    assert!(validate_document_qualifiers(&doc)
        .iter()
        .any(|i| i.message.contains("require neuroflow 0.1.1")));
    for (data_type, qualifier, value) in [
        ("neuro:transform", "space", json!("MNI152Lin")),
        ("core:string", "formats", json!(["nifti"])),
        ("neuro:surface", "resolution", json!(1)),
        ("neuro:volume", "density", json!("32k")),
        ("neuro:mask", "labelSystem", json!("binary")),
        ("neuro:volume", "formats", json!([])),
        ("neuro:volume", "formats", json!(["nifti", "nifti"])),
        ("neuro:volume", "formats", json!(["neuro:nifti"])),
        ("neuro:volume", "resolution", json!(0)),
        ("neuro:volume", "space", json!("@7")),
        ("neuro:volume", "space", json!("steps.a.outputs.image")),
        ("neuro:volume", "space", json!("inputs.image")),
    ] {
        let mut declaration = json!({"type":data_type});
        declaration[qualifier] = value;
        let doc = json!({"kind":"tool", "neuroflow":"0.1.1", "inputs":{"image":declaration}, "outputs":{}});
        assert!(
            !validate_document_qualifiers(&doc).is_empty(),
            "must reject {doc}"
        );
    }
    for input in ["missing", "name"] {
        let doc = json!({"kind":"tool", "neuroflow":"0.1.1", "inputs":{"name":{"type":"core:string"}}, "outputs":{"out":{"type":"neuro:volume", "space":format!("inputs.{input}")}}});
        assert!(!validate_document_qualifiers(&doc).is_empty());
    }
}

#[test]
fn context_declarations_do_not_prove_subject_identity() {
    let workflow =
        json!({"context":{"fields":{"image":{"type":"neuro:volume", "space":"individual"}}}});
    assert!(resolve_qualifiers("context.image", &workflow, &json!([]))
        .space_identity
        .is_none());
}

#[test]
fn versioned_refs_resolve_qualifiers_and_unused_tools_do_not_block() {
    let (mut workflow, mut tools) = graph();
    tools[0]["version"] = json!("1.2.3");
    workflow["steps"]["a"]["tool"] = json!("test/pass@1.2.3");
    tools.as_array_mut().unwrap().push(json!({"kind":"tool", "id":"test/unrelated", "neuroflow":"0.1.0", "inputs":{"x":{"type":"core:string", "space":"individual"}}, "outputs":{}}));
    let report = validate_workflow_value_with_tools(&workflow, Some(&tools));
    assert!(report.ok && report.issues.is_empty(), "{report:?}");
    assert_eq!(
        resolve_qualifiers("steps.b.outputs.image", &workflow, &tools)
            .space_identity
            .as_deref(),
        Some("inputs.t1")
    );
    workflow["steps"]["a"]["tool"] = json!("test/pass@1.2.4");
    assert!(!validate_workflow_value_with_tools(&workflow, Some(&tools)).ok);
}

#[test]
fn unversioned_resolution_uses_the_same_registry_entry_as_validation() {
    let (workflow, mut tools) = graph();
    let mut replacement = tools[0].clone();
    replacement["outputs"]["image"]["formats"] = json!(["mgz"]);
    tools.as_array_mut().unwrap().push(replacement);
    assert_eq!(
        resolve_qualifiers("steps.b.outputs.image", &workflow, &tools).declaration["formats"],
        json!(["mgz"])
    );
    assert!(!validate_workflow_value_with_tools(&workflow, Some(&tools)).ok);
}

#[test]
fn missing_registry_does_not_drop_workflow_output_obligations() {
    let (workflow, _) = graph();
    let report = validate_workflow_value_with_tools(&workflow, None);
    assert!(report
        .issues
        .iter()
        .any(|i| i.path.as_deref() == Some("outputs.image.ref")
            && i.message.contains("requires a runtime check")));
}

#[test]
fn context_mappings_enforce_declared_requirements_before_consumers() {
    let (mut workflow, tools) = graph();
    workflow["context"] = json!({"fields":{"image":{"type":"neuro:volume", "formats":["nifti"]}}});
    workflow["steps"]["a"]["outputMappings"] = json!({"image":"image"});
    workflow["steps"]["b"]["inputs"]["image"] = json!({"ref":"context.image"});
    let report = validate_workflow_value_with_tools(&workflow, Some(&tools));
    assert!(report.ok, "{report:?}");
    assert!(!report
        .issues
        .iter()
        .any(|i| i.path.as_deref() == Some("steps.a.outputMappings.image")));

    workflow["inputs"]["t1"]["formats"] = json!(["mgz"]);
    let report = validate_workflow_value_with_tools(&workflow, Some(&tools));
    assert!(
        report.issues.iter().any(|i| i.severity == "error"
            && i.path.as_deref() == Some("steps.a.outputMappings.image")
            && i.message.contains("formats is incompatible")),
        "{report:?}"
    );

    workflow["inputs"]["t1"]
        .as_object_mut()
        .unwrap()
        .remove("formats");
    let report = validate_workflow_value_with_tools(&workflow, Some(&tools));
    assert!(
        report.issues.iter().any(|i| i.severity == "warning"
            && i.path.as_deref() == Some("steps.a.outputMappings.image")
            && i.message.contains("formats requires a runtime check")),
        "{report:?}"
    );

    workflow["context"]["fields"]["image"]["space"] = json!("individual");
    let report = validate_workflow_value_with_tools(&workflow, Some(&tools));
    assert!(
        report.issues.iter().any(
            |i| i.path.as_deref() == Some("steps.a.outputMappings.image")
                && i.message.contains("space requires a runtime check")
        ),
        "{report:?}"
    );
}

#[test]
fn qualified_context_defaults_require_inspection_not_filename_guesses() {
    let (mut workflow, tools) = graph();
    workflow["context"] = json!({"fields":{"image":{"type":"neuro:volume", "formats":["nifti"], "default":"looks-like-nifti.nii"}}});
    let report = validate_workflow_value_with_tools(&workflow, Some(&tools));
    assert!(
        report.issues.iter().any(
            |i| i.path.as_deref() == Some("context.fields.image.default")
                && i.message.contains("formats requires a runtime check")
        ),
        "{report:?}"
    );
}
