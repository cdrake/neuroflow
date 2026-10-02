//! Real subprocess boundary tests: a marker exists only if the interpreter ran.
use crate::{registry::Registry, runtime, Config};
use flate2::{write::GzEncoder, Compression};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
};

struct Fixture {
    root: PathBuf,
    cfg: Config,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "neuroflow-qualifiers-{}",
            crate::util::new_run_id()
        ));
        fs::create_dir_all(root.join("registry")).unwrap();
        fs::create_dir(root.join("runs")).unwrap();
        fs::write(
            root.join("registry/copy.py"),
            r#"import json, os, pathlib, shutil
ctx=json.loads((pathlib.Path(os.environ['NEUROFLOW_SESSION'])/'context.json').read_text())
out=pathlib.Path(ctx['outputDir'])
marker=pathlib.Path(ctx['inputs']['marker']); marker.write_text('launched')
shutil.copyfile(ctx['inputs']['image'], out/'image.bin')
(out/'result.json').write_text(json.dumps({'image': 'image.bin'}))
"#,
        )
        .unwrap();
        let cfg = Config {
            registry_dirs: vec![root.join("registry")],
            spec_dir: None,
            data_roots: vec![root.clone()],
            sessions_root: root.join("runs"),
            interpreters: HashMap::new(),
            step_timeout: None,
            summary_max_bytes: 1024 * 1024,
        };
        Self { root, cfg }
    }
    fn image(&self, name: &str, gzip: bool, units: u8, code: i16) -> PathBuf {
        let mut bytes = vec![0u8; 352 + 16];
        bytes[0..4].copy_from_slice(&348i32.to_le_bytes());
        for (i, dim) in [3i16, 2, 2, 2, 1, 1, 1, 1].iter().enumerate() {
            bytes[40 + i * 2..42 + i * 2].copy_from_slice(&dim.to_le_bytes());
        }
        bytes[70..72].copy_from_slice(&4i16.to_le_bytes());
        bytes[72..74].copy_from_slice(&16i16.to_le_bytes());
        for i in 0..4 {
            bytes[76 + i * 4..80 + i * 4].copy_from_slice(&2f32.to_le_bytes());
        }
        bytes[108..112].copy_from_slice(&352f32.to_le_bytes());
        bytes[123] = units;
        bytes[254..256].copy_from_slice(&code.to_le_bytes());
        for offset in [280, 300, 320] {
            bytes[offset..offset + 4].copy_from_slice(&2f32.to_le_bytes());
        }
        bytes[344..348].copy_from_slice(b"n+1\0");
        let path = self.root.join(name);
        if gzip {
            let mut encoded = GzEncoder::new(Vec::new(), Compression::default());
            encoded.write_all(&bytes).unwrap();
            fs::write(&path, encoded.finish().unwrap()).unwrap();
        } else {
            fs::write(&path, bytes).unwrap();
        }
        path
    }
    fn tool(&self, id: &str, input: Value, output: Value) -> Registry {
        let document = json!({
            "neuroflow": "0.1.1", "kind": "tool", "id": format!("test/{id}"),
            "version": "1.0.0", "description": "Copy one artifact after checking its qualifiers.",
            "inputs": { "image": input, "marker": { "type": "core:string", "description": "Launch marker path." } },
            "outputs": { "image": output },
            "extensions": { "neuroflow/launch": {
                "kind": "script", "interpreter": "python3", "script": "copy.py", "completion": "exit"
            } }
        });
        fs::write(
            self.root.join(format!("registry/{id}.json")),
            document.to_string(),
        )
        .unwrap();
        Registry::load(&self.cfg.registry_dirs, &self.cfg.interpreters).unwrap()
    }
    fn run(
        &self,
        registry: &Registry,
        id: &str,
        image: Value,
        marker: &str,
    ) -> runtime::RunOutcome {
        let workflow = runtime::wrap_tool(registry.tool(&format!("test/{id}")).unwrap());
        runtime::run_workflow(
            &self.cfg,
            registry,
            &workflow,
            json!({ "image": image, "marker": self.root.join(marker) })
                .as_object()
                .unwrap(),
            &json!({}),
            &mut |_, _, _| {},
        )
        .unwrap()
    }
    fn record(&self, run: &runtime::RunOutcome) -> Value {
        serde_json::from_str(
            &fs::read_to_string(self.cfg.sessions_root.join(&run.run_id).join("run.json")).unwrap(),
        )
        .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn declaration(extra: Value) -> Value {
    let mut declaration = json!({ "type": "neuro:volume", "description": "Image." });
    declaration
        .as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    declaration
}

#[test]
fn encoded_gzip_with_nii_suffix_is_rejected_before_launch() {
    let f = Fixture::new();
    let file = f.image("deceptive.nii", true, 2, 1);
    let registry = f.tool(
        "copy",
        declaration(json!({ "formats": ["nii"] })),
        declaration(json!({})),
    );
    let run = f.run(&registry, "copy", json!(file), "marker");
    assert_eq!(run.status, "failed");
    assert!(!f.root.join("marker").exists());
    assert!(run.structured["error"]
        .as_str()
        .unwrap()
        .contains("formats constraint violated"));
    assert!(f.record(&run)["qualifierChecks"]
        .as_array()
        .unwrap()
        .iter()
        .any(|c| c["check"]["source"] == json!(["nii-gz"])));
}

#[test]
fn no_format_inspector_fails_closed_even_with_matching_annotation() {
    let f = Fixture::new();
    let file = f.root.join("image.mgz");
    fs::write(&file, "not a supported byte layout").unwrap();
    let registry = f.tool(
        "copy",
        declaration(json!({ "formats": ["mgz"] })),
        declaration(json!({})),
    );
    let run = f.run(&registry, "copy", json!(file), "marker");
    assert_eq!(run.status, "failed");
    assert!(!f.root.join("marker").exists());
    assert!(run.structured["error"]
        .as_str()
        .unwrap()
        .contains("no inspector"));
}

#[test]
fn valid_nifti_launches_and_keeps_measured_and_inherited_evidence() {
    let f = Fixture::new();
    let file = f.image("no-extension", false, 2, 1);
    let registry = f.tool("copy", declaration(json!({ "formats": ["nifti"], "space": "individual", "resolution": 2 })),
        declaration(json!({ "formats": "inputs.image", "space": "inputs.image", "resolution": "inputs.image" })));
    let run = f.run(&registry, "copy", json!(file), "marker");
    assert_eq!(run.status, "completed", "{}", run.structured);
    assert!(f.root.join("marker").exists());
    let record = f.record(&run);
    let input = &record["steps"]["copy"]["inputEvidence"]["image"];
    let output = &record["steps"]["copy"]["outputEvidence"]["image"];
    assert_eq!(input["spaceIdentity"], output["spaceIdentity"]);
    assert_eq!(output["declaration"]["formats"], json!(["nii"]));
    assert_eq!(output["declaration"]["resolution"], json!([2.0, 2.0, 2.0]));
    let provenance: Value = serde_json::from_str(
        &fs::read_to_string(
            f.cfg
                .sessions_root
                .join(&run.run_id)
                .join("run.provenance.json"),
        )
        .unwrap(),
    )
    .unwrap();
    assert!(provenance["extensions"]["neuroflow/qualifiers"]["steps"].is_array());
}

#[test]
fn unknown_units_and_aligned_anatomy_are_not_assumed_mm_or_individual() {
    for (qualifier, units, code) in [
        (json!({ "resolution": 2 }), 0, 1),
        (json!({ "space": "individual" }), 2, 2),
    ] {
        let f = Fixture::new();
        let file = f.image("image.nii", false, units, code);
        let registry = f.tool("copy", declaration(qualifier), declaration(json!({})));
        let run = f.run(&registry, "copy", json!(file), "marker");
        assert_eq!(run.status, "failed");
        assert!(!f.root.join("marker").exists());
    }
}

#[test]
fn caller_annotations_cannot_establish_template_or_label_identity() {
    for claim in [
        json!({ "space": "fsaverage@7.4.1" }),
        json!({ "labelSystem": "freesurfer" }),
    ] {
        let f = Fixture::new();
        let file = f.image("image.nii", false, 2, 1);
        let mut input = declaration(claim);
        input["type"] = json!("neuro:label-map");
        let registry = f.tool("copy", input, declaration(json!({})));
        let run = f.run(&registry, "copy", json!(file), "marker");
        assert_eq!(run.status, "failed");
        assert!(!f.root.join("marker").exists());
    }
}

#[test]
fn literal_binding_is_checked_before_launch() {
    let f = Fixture::new();
    let file = f.image("image.nii", true, 2, 1);
    let registry = f.tool(
        "copy",
        declaration(json!({ "formats": ["nii"] })),
        declaration(json!({})),
    );
    let mut workflow = runtime::wrap_tool(registry.tool("test/copy").unwrap());
    workflow["inputs"] = json!({});
    workflow["steps"]["copy"]["inputs"] = json!({
        "image": { "constant": file }, "marker": { "constant": f.root.join("marker") }
    });
    let run = runtime::run_workflow(
        &f.cfg,
        &registry,
        &workflow,
        &Default::default(),
        &json!({}),
        &mut |_, _, _| {},
    )
    .unwrap();
    assert_eq!(run.status, "failed");
    assert!(!f.root.join("marker").exists());
    assert!(run.structured["error"]
        .as_str()
        .unwrap()
        .contains("steps.copy.inputs.image"));
}

#[test]
fn producer_label_identity_survives_uri_chaining_but_mutated_bytes_do_not() {
    let f = Fixture::new();
    let file = f.image("labels.nii", false, 2, 1);
    let mut labels = declaration(
        json!({ "formats": ["nifti"], "labelSystem": "freesurfer@7.4.1", "space": "inputs.image" }),
    );
    labels["type"] = json!("neuro:label-map");
    let registry = f.tool(
        "produce",
        declaration(json!({ "formats": ["nifti"] })),
        labels.clone(),
    );
    let first = f.run(&registry, "produce", json!(file), "producer-marker");
    assert_eq!(first.status, "completed", "{}", first.structured);
    let uri = first.structured["outputs"]["image"]["uri"].clone();
    labels.as_object_mut().unwrap().remove("space");
    let registry = f.tool("consume", labels.clone(), declaration(json!({})));
    let second = f.run(&registry, "consume", uri.clone(), "consumer-marker");
    assert_eq!(second.status, "completed", "{}", second.structured);
    assert!(f.root.join("consumer-marker").exists());
    let input = &f.record(&second)["steps"]["consume"]["inputEvidence"]["image"];
    assert_eq!(input["producer"]["run"], first.run_id);
    assert_eq!(input["declaration"]["labelSystem"], "freesurfer@7.4.1");
    // A different revision requires an actual table reader, which this runtime
    // deliberately does not advertise.
    labels["labelSystem"] = json!("freesurfer@7.3.2");
    let registry = f.tool("different", labels, declaration(json!({})));
    let mismatch = f.run(&registry, "different", uri.clone(), "revision-marker");
    assert_eq!(mismatch.status, "failed");
    assert!(!f.root.join("revision-marker").exists());
    let artifact = Path::new(
        first.structured["outputs"]["image"]["path"]
            .as_str()
            .unwrap(),
    );
    let mut changed = fs::read(artifact).unwrap();
    changed[352] = 3;
    fs::write(artifact, changed).unwrap();
    let modified = f.run(&registry, "consume", uri, "mutated-marker");
    assert_eq!(modified.status, "failed");
    assert!(!f.root.join("mutated-marker").exists());
    assert!(modified.structured["error"]
        .as_str()
        .unwrap()
        .contains("changed since"));
}

#[test]
fn one_workflow_carries_registered_and_inherited_evidence_to_its_consumer() {
    let f = Fixture::new();
    let file = f.image("scanner.nii", false, 2, 1);
    f.tool("first", declaration(json!({ "formats": ["nifti"] })),
        declaration(json!({ "formats": "inputs.image", "space": "inputs.image", "resolution": "inputs.image" })));
    let registry = f.tool(
        "second",
        declaration(json!({ "formats": ["nii"], "space": "individual", "resolution": 2 })),
        declaration(json!({ "space": "inputs.image" })),
    );
    let workflow = json!({
        "neuroflow": "0.1.1", "kind": "workflow", "id": "test/chain", "version": "1.0.0",
        "description": "Check provenance through a workflow reference.",
        "inputs": { "image": declaration(json!({})) },
        "steps": {
            "first": { "tool": "test/first", "inputs": {
                "image": { "ref": "inputs.image" }, "marker": { "constant": f.root.join("first-marker") }
            } },
            "second": { "tool": "test/second", "inputs": {
                "image": { "ref": "steps.first.outputs.image" }, "marker": { "constant": f.root.join("second-marker") }
            } }
        },
        "outputs": { "image": { "type": "neuro:volume", "ref": "steps.second.outputs.image", "formats": ["nifti"] } }
    });
    let run = runtime::run_workflow(
        &f.cfg,
        &registry,
        &workflow,
        json!({ "image": file }).as_object().unwrap(),
        &json!({}),
        &mut |_, _, _| {},
    )
    .unwrap();
    assert_eq!(run.status, "completed", "{}", run.structured);
    assert!(f.root.join("second-marker").exists());
    let record = f.record(&run);
    assert_eq!(
        record["steps"]["first"]["inputEvidence"]["image"]["spaceIdentity"],
        record["steps"]["second"]["inputEvidence"]["image"]["spaceIdentity"]
    );
    assert_eq!(
        record["steps"]["second"]["inputEvidence"]["image"]["producer"]["step"],
        "first"
    );
    assert!(record["outputQualifierChecks"]["image"]
        .as_array()
        .unwrap()
        .iter()
        .all(|check| check["check"]["outcome"] == "compatible"));
}

#[test]
fn every_array_element_is_inspected_before_launch() {
    let f = Fixture::new();
    let plain = f.image("plain", false, 2, 1);
    let gzip = f.image("gzip.nii", true, 2, 1);
    let mut input = declaration(json!({ "formats": ["nii"] }));
    input["type"] = json!("core:array<neuro:volume>");
    let registry = f.tool("copy", input, declaration(json!({})));
    let run = f.run(&registry, "copy", json!([plain, gzip]), "marker");
    assert_eq!(run.status, "failed");
    assert!(!f.root.join("marker").exists());
    assert!(run.structured["error"]
        .as_str()
        .unwrap()
        .contains("inputs.image[1]"));
}

#[test]
fn affine_equality_does_not_unify_independent_input_identities() {
    let f = Fixture::new();
    let a = f.image("a.nii", false, 2, 1);
    let b = f.image("b.nii", false, 2, 1);
    let mut bytes = fs::read(&b).unwrap();
    bytes[352] = 1;
    fs::write(&b, bytes).unwrap();
    let ae = crate::qualifiers::inspect(&f.cfg, &json!(a), &json!(a), &HashMap::new()).unwrap();
    let be = crate::qualifiers::inspect(&f.cfg, &json!(b), &json!(b), &HashMap::new()).unwrap();
    let checks = neuroflow_core::qualifiers::compare_qualifiers(
        &ae["declaration"],
        &be["declaration"],
        ae["spaceIdentity"].as_str(),
        be["spaceIdentity"].as_str(),
    );
    assert!(checks.iter().any(|c| c.qualifier == "space"
        && c.outcome == neuroflow_core::qualifiers::Compatibility::RequiresRuntimeCheck));
}

#[test]
fn scalar_artifact_output_cannot_be_replaced_by_an_empty_array() {
    let f = Fixture::new();
    let file = f.image("input.nii", false, 2, 1);
    let script = f.root.join("registry/copy.py");
    fs::write(
        &script,
        fs::read_to_string(&script)
            .unwrap()
            .replace("{'image': 'image.bin'}", "{'image': []}"),
    )
    .unwrap();
    let registry = f.tool(
        "copy",
        declaration(json!({})),
        declaration(json!({ "formats": ["nifti"] })),
    );
    let run = f.run(&registry, "copy", json!(file), "marker");
    assert_eq!(run.status, "failed");
    assert!(run.structured["error"]
        .as_str()
        .unwrap()
        .contains("expected an artifact reference string"));
}

#[test]
fn every_array_output_must_meet_its_measured_format_promise() {
    let f = Fixture::new();
    let file = f.image("input.nii", false, 2, 1);
    let script = f.root.join("registry/copy.py");
    fs::write(
        &script,
        fs::read_to_string(&script)
            .unwrap()
            .replace("{'image': 'image.bin'}", "{'image': ['image.bin']}"),
    )
    .unwrap();
    let mut output = declaration(json!({ "formats": ["nii-gz"] }));
    output["type"] = json!("core:array<neuro:volume>");
    let registry = f.tool("copy", declaration(json!({})), output);
    let run = f.run(&registry, "copy", json!(file), "marker");
    assert_eq!(run.status, "failed");
    assert!(run.structured["error"]
        .as_str()
        .unwrap()
        .contains("outputs.image[0]: formats constraint violated"));
}

#[test]
fn conflicting_nifti_transform_codes_do_not_establish_individual_space() {
    let f = Fixture::new();
    let file = f.image("input.nii", false, 2, 1);
    let mut bytes = fs::read(&file).unwrap();
    bytes[252..254].copy_from_slice(&4i16.to_le_bytes());
    fs::write(&file, bytes).unwrap();
    let registry = f.tool(
        "copy",
        declaration(json!({ "space": "individual" })),
        declaration(json!({})),
    );
    let run = f.run(&registry, "copy", json!(file), "marker");
    assert_eq!(run.status, "failed");
    assert!(!f.root.join("marker").exists());
}

#[test]
fn constrained_context_mapping_blocks_its_consumer() {
    let f = Fixture::new();
    let file = f.image("input.nii", true, 2, 1);
    f.tool(
        "first",
        declaration(json!({ "formats": ["nifti"] })),
        declaration(json!({ "formats": ["nifti"] })),
    );
    let registry = f.tool("second", declaration(json!({})), declaration(json!({})));
    let workflow = json!({
        "neuroflow": "0.1.1", "kind": "workflow", "id": "test/context", "version": "1.0.0",
        "description": "Context constraints must be established before publishing a value.",
        "inputs": { "image": declaration(json!({})) },
        "context": { "fields": { "image": declaration(json!({ "formats": ["nii"] })) } },
        "steps": {
            "first": { "tool": "test/first", "inputs": {
                "image": { "ref": "inputs.image" }, "marker": { "constant": f.root.join("first-marker") }
            }, "outputMappings": { "image": "image" } },
            "second": { "tool": "test/second", "inputs": {
                "image": { "ref": "context.image" }, "marker": { "constant": f.root.join("second-marker") }
            } }
        },
        "outputs": { "image": { "type": "neuro:volume", "ref": "steps.second.outputs.image" } }
    });
    let run = runtime::run_workflow(
        &f.cfg,
        &registry,
        &workflow,
        json!({ "image": file }).as_object().unwrap(),
        &json!({}),
        &mut |_, _, _| {},
    )
    .unwrap();
    assert_eq!(run.status, "failed");
    assert!(f.root.join("first-marker").exists());
    assert!(!f.root.join("second-marker").exists());
    assert!(run.structured["error"]
        .as_str()
        .unwrap()
        .contains("context.image"));
}

#[test]
fn constrained_context_default_is_not_trusted_as_evidence() {
    let f = Fixture::new();
    let file = f.image("input.nii", true, 2, 1);
    let registry = f.tool("copy", declaration(json!({})), declaration(json!({})));
    let mut workflow = runtime::wrap_tool(registry.tool("test/copy").unwrap());
    let mut field = declaration(json!({ "formats": ["nii"] }));
    field["default"] = json!(file);
    workflow["context"] = json!({ "fields": { "image": field } });
    workflow["inputs"].as_object_mut().unwrap().remove("image");
    workflow["steps"]["copy"]["inputs"]["image"] = json!({ "ref": "context.image" });
    let run = runtime::run_workflow(
        &f.cfg,
        &registry,
        &workflow,
        json!({ "marker": f.root.join("marker") })
            .as_object()
            .unwrap(),
        &json!({}),
        &mut |_, _, _| {},
    )
    .unwrap();
    assert_eq!(run.status, "failed");
    assert!(!f.root.join("marker").exists());
    assert!(run.structured["error"]
        .as_str()
        .unwrap()
        .contains("context.image"));
}

#[test]
fn artifact_uri_semantic_type_is_checked_before_direct_tool_launch() {
    let f = Fixture::new();
    let file = f.image("input.nii", false, 2, 1);
    let registry = f.tool(
        "surface",
        declaration(json!({})),
        json!({ "type": "neuro:surface", "description": "Registered surface artifact." }),
    );
    let first = f.run(&registry, "surface", json!(file), "first-marker");
    assert_eq!(first.status, "completed");
    let registry = f.tool("volume", declaration(json!({})), declaration(json!({})));
    let workflow = runtime::wrap_tool(registry.tool("test/volume").unwrap());
    let result = runtime::run_workflow(&f.cfg, &registry, &workflow,
        json!({ "image": first.structured["outputs"]["image"]["uri"], "marker": f.root.join("consumer-marker") }).as_object().unwrap(),
        &json!({}), &mut |_, _, _| {});
    match result {
        Err(error) => assert!(
            error.contains("artifact type neuro:surface is incompatible with neuro:volume"),
            "{error}"
        ),
        Ok(_) => panic!("incompatible artifact URI should be rejected"),
    }
    assert!(!f.root.join("consumer-marker").exists());
}
