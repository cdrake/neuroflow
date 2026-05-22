use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ValidationIssue {
    pub severity: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ValidationReport {
    pub ok: bool,
    pub issues: Vec<ValidationIssue>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanStep {
    pub id: String,
    pub tool: String,
    pub reads: Vec<String>,
    pub writes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowPlan {
    #[serde(rename = "workflowId")]
    pub workflow_id: String,
    pub steps: Vec<PlanStep>,
    pub outputs: Vec<String>,
}

pub fn validate_workflow_str(json: &str) -> Result<ValidationReport, serde_json::Error> {
    let value: Value = serde_json::from_str(json)?;
    Ok(validate_workflow_value(&value))
}

pub fn plan_workflow_str(json: &str) -> Result<WorkflowPlan, serde_json::Error> {
    let value: Value = serde_json::from_str(json)?;
    Ok(plan_workflow_value(&value))
}

pub fn validate_workflow_value(workflow: &Value) -> ValidationReport {
    validate_workflow_value_with_tools(workflow, None)
}

pub fn validate_workflow_value_with_tools(
    workflow: &Value,
    tools: Option<&Value>,
) -> ValidationReport {
    let mut issues = Vec::new();

    let Some(root) = workflow.as_object() else {
        return ValidationReport {
            ok: false,
            issues: vec![ValidationIssue {
                severity: "error".to_string(),
                path: None,
                message: "Workflow document must be a JSON object.".to_string(),
            }],
        };
    };

    if root.get("kind").and_then(Value::as_str) != Some("workflow") {
        issues.push(error("kind", "Document kind must be workflow."));
    }

    if root.get("neuroflow").and_then(Value::as_str) != Some("0.1.0") {
        issues.push(error(
            "neuroflow",
            "Workflow must target NeuroFlow spec version 0.1.0.",
        ));
    }

    let id = root.get("id").and_then(Value::as_str).unwrap_or("");
    if id.is_empty() || !id.contains('/') {
        issues.push(error(
            "id",
            "Workflow id must be a namespace-qualified document id.",
        ));
    }

    let version = root.get("version").and_then(Value::as_str).unwrap_or("");
    if !valid_semver(version) {
        issues.push(error(
            "version",
            "Workflow version must use semantic versioning.",
        ));
    }

    if root
        .get("description")
        .and_then(Value::as_str)
        .unwrap_or("")
        .is_empty()
    {
        issues.push(error("description", "Workflow description is required."));
    }

    let context_fields = root
        .get("context")
        .and_then(|v| v.get("fields"))
        .and_then(Value::as_object);
    let tool_registry = collect_tool_registry(tools);

    let steps = root.get("steps").and_then(Value::as_object);
    let Some(steps) = steps else {
        issues.push(error("steps", "Workflow steps must be an object."));
        return finish(issues);
    };

    for (step_name, step) in steps {
        let path = format!("steps.{step_name}");
        let Some(step_obj) = step.as_object() else {
            issues.push(error(path, "Step must be an object."));
            continue;
        };

        let tool_ref = step_obj
            .get("tool")
            .and_then(Value::as_str)
            .unwrap_or("");
        if tool_ref.is_empty() {
            issues.push(error(format!("{path}.tool"), "Step tool is required."));
        }
        let tool = tool_registry.get(tool_ref);
        if !tool_registry.is_empty() && !tool_ref.is_empty() && tool.is_none() {
            issues.push(error(
                format!("{path}.tool"),
                format!("Step references unknown tool {tool_ref}."),
            ));
        }

        let inputs = step_obj.get("inputs").and_then(Value::as_object);
        let Some(inputs) = inputs else {
            issues.push(error(format!("{path}.inputs"), "Step inputs must be an object."));
            continue;
        };

        if let Some(tool) = tool {
            for (input_name, input_def) in tool.inputs {
                if !required_input(input_def) {
                    continue;
                }
                if binding_is_missing(inputs.get(input_name)) {
                    issues.push(error(
                        format!("{path}.inputs.{input_name}"),
                        format!("Required input {input_name} for {} is not satisfied.", tool.name),
                    ));
                }
            }
        }

        for (input_name, binding) in inputs {
            let binding_path = format!("{path}.inputs.{input_name}");
            let Some(binding_obj) = binding.as_object() else {
                issues.push(error(binding_path, "Binding must be an object."));
                continue;
            };

            let has_ref = binding_obj.get("ref").is_some();
            let has_constant = binding_obj.get("constant").is_some();
            if has_ref == has_constant {
                issues.push(error(
                    binding_path,
                    "Binding must contain exactly one of ref or constant.",
                ));
                continue;
            }

            if let Some(reference) = binding_obj.get("ref").and_then(Value::as_str) {
                if !valid_reference(reference) {
                    issues.push(error(
                        binding_path,
                        format!("Invalid reference {reference}."),
                    ));
                    continue;
                }

                if let Some(field) = reference.strip_prefix("context.") {
                    if !context_has_field(context_fields, field) {
                        issues.push(warning(
                            binding_path.clone(),
                            format!("Reference {reference} points to an undeclared context field."),
                        ));
                    }
                }

                if let Some(ref_step) = referenced_step(reference) {
                    if !steps.contains_key(ref_step) {
                        issues.push(error(
                            binding_path.clone(),
                            format!("Reference {reference} points to an unknown step."),
                        ));
                        continue;
                    }
                }

                if let Some(tool) = tool {
                    if let Some(input_def) = tool.inputs.get(input_name) {
                        if let (Some(source_type), Some(input_type)) = (
                            resolve_ref_type(reference, root, steps, &tool_registry),
                            declaration_type(input_def),
                        ) {
                            if !is_type_compatible(&source_type, &input_type) {
                                issues.push(warning(
                                    binding_path.clone(),
                                    format!(
                                        "Input {input_name} expects {input_type} but {reference} provides {source_type}."
                                    ),
                                ));
                            }
                        }
                    } else {
                        issues.push(warning(
                            binding_path.clone(),
                            format!("Input {input_name} is not declared by {}.", tool.name),
                        ));
                    }
                }
            }
        }

        if let Some(mappings) = step_obj.get("outputMappings").and_then(Value::as_object) {
            for (output_name, field_value) in mappings {
                let Some(field) = field_value.as_str() else {
                    issues.push(error(
                        format!("{path}.outputMappings.{output_name}"),
                        "Output mapping target must be a context field name.",
                    ));
                    continue;
                };
                if let Some(tool) = tool {
                    if !tool.outputs.contains_key(output_name) {
                        issues.push(error(
                            format!("{path}.outputMappings.{output_name}"),
                            format!(
                                "Output mapping references unknown output {output_name} on {}.",
                                tool.name
                            ),
                        ));
                        continue;
                    }
                }
                if !context_has_field(context_fields, field) {
                    issues.push(warning(
                        format!("{path}.outputMappings.{output_name}"),
                        format!("Output mapping writes undeclared context field {field}."),
                    ));
                }
            }
        }
    }

    if let Some(outputs) = root.get("outputs").and_then(Value::as_object) {
        for (output_name, output) in outputs {
            let reference = output.get("ref").and_then(Value::as_str).unwrap_or("");
            if !reference.starts_with("steps.") {
                issues.push(error(
                    format!("outputs.{output_name}.ref"),
                    "Workflow output must reference a step output.",
                ));
                continue;
            }
            if tool_registry.is_empty() {
                continue;
            }
            let Some(source_type) = resolve_ref_type(reference, root, steps, &tool_registry) else {
                issues.push(error(
                    format!("outputs.{output_name}.ref"),
                    format!("Workflow output references unknown value {reference}."),
                ));
                continue;
            };
            if let Some(output_type) = output.get("type").and_then(Value::as_str) {
                if !is_type_compatible(&source_type, output_type) {
                    issues.push(warning(
                        format!("outputs.{output_name}.ref"),
                        format!(
                            "Workflow output {output_name} declares {output_type} but source provides {source_type}."
                        ),
                    ));
                }
            }
        }
    } else {
        issues.push(error("outputs", "Workflow outputs must be an object."));
    }

    finish(issues)
}

pub fn plan_workflow_value(workflow: &Value) -> WorkflowPlan {
    let workflow_id = workflow
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string();

    let steps = workflow
        .get("steps")
        .and_then(Value::as_object)
        .map(|steps| {
            steps
                .iter()
                .map(|(step_id, step)| {
                    let tool = step
                        .get("tool")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown")
                        .to_string();
                    let reads = step
                        .get("inputs")
                        .and_then(Value::as_object)
                        .map(read_refs)
                        .unwrap_or_default();
                    let writes = step
                        .get("outputMappings")
                        .and_then(Value::as_object)
                        .map(|mappings| {
                            mappings
                                .iter()
                                .filter_map(|(output, field)| {
                                    field.as_str().map(|field| {
                                        format!(
                                            "steps.{step_id}.outputs.{output} -> context.{field}"
                                        )
                                    })
                                })
                                .collect()
                        })
                        .unwrap_or_default();

                    PlanStep {
                        id: step_id.to_string(),
                        tool,
                        reads,
                        writes,
                    }
                })
                .collect()
        })
        .unwrap_or_default();

    let outputs = workflow
        .get("outputs")
        .and_then(Value::as_object)
        .map(|outputs| {
            outputs
                .iter()
                .filter_map(|(name, output)| {
                    output
                        .get("ref")
                        .and_then(Value::as_str)
                        .map(|reference| format!("{name} <- {reference}"))
                })
                .collect()
        })
        .unwrap_or_default();

    WorkflowPlan {
        workflow_id,
        steps,
        outputs,
    }
}

fn read_refs(inputs: &serde_json::Map<String, Value>) -> Vec<String> {
    inputs
        .values()
        .filter_map(|binding| {
            binding
                .get("ref")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .collect()
}

#[derive(Clone, Copy)]
struct ToolContract<'a> {
    name: &'a str,
    inputs: &'a serde_json::Map<String, Value>,
    outputs: &'a serde_json::Map<String, Value>,
}

fn collect_tool_registry<'a>(tools: Option<&'a Value>) -> HashMap<String, ToolContract<'a>> {
    let mut registry = HashMap::new();
    let Some(tool_list) = tools.and_then(Value::as_array) else {
        return registry;
    };

    for tool in tool_list {
        let Some(tool_obj) = tool.as_object() else {
            continue;
        };
        let Some(id) = tool_obj.get("id").and_then(Value::as_str) else {
            continue;
        };
        let Some(inputs) = tool_obj.get("inputs").and_then(Value::as_object) else {
            continue;
        };
        let Some(outputs) = tool_obj.get("outputs").and_then(Value::as_object) else {
            continue;
        };
        let name = tool_obj
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or(id);
        let contract = ToolContract {
            name,
            inputs,
            outputs,
        };
        registry.insert(id.to_string(), contract);
        registry.insert(name.to_string(), contract);
    }

    registry
}

fn required_input(input_def: &Value) -> bool {
    input_def
        .get("optional")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        == false
        && input_def.get("default").is_none()
}

fn binding_is_missing(binding: Option<&Value>) -> bool {
    let Some(binding) = binding else {
        return true;
    };
    if let Some(reference) = binding.get("ref").and_then(Value::as_str) {
        return reference.trim().is_empty();
    }
    if let Some(constant) = binding.get("constant") {
        return constant.as_str().map(str::is_empty).unwrap_or(false);
    }
    true
}

fn resolve_ref_type(
    reference: &str,
    root: &serde_json::Map<String, Value>,
    steps: &serde_json::Map<String, Value>,
    tools: &HashMap<String, ToolContract<'_>>,
) -> Option<String> {
    if reference == "context" {
        return Some("core:object".to_string());
    }

    let parts: Vec<&str> = reference.split('.').collect();
    match parts.as_slice() {
        ["inputs", input] => root
            .get("inputs")
            .and_then(Value::as_object)
            .and_then(|inputs| inputs.get(*input))
            .and_then(declaration_type),
        ["context", field] => root
            .get("context")
            .and_then(|context| context.get("fields"))
            .and_then(Value::as_object)
            .and_then(|fields| fields.get(*field))
            .and_then(declaration_type),
        ["steps", step_name, "outputs", output_name] => {
            let step = steps.get(*step_name)?;
            let tool_ref = step.get("tool").and_then(Value::as_str)?;
            let tool = tools.get(tool_ref)?;
            tool.outputs.get(*output_name).and_then(declaration_type)
        }
        _ => None,
    }
}

fn declaration_type(value: &Value) -> Option<String> {
    value.get("type").and_then(Value::as_str).map(str::to_string)
}

fn is_type_compatible(source_type: &str, input_type: &str) -> bool {
    if source_type == input_type {
        return true;
    }

    if coercible_to(source_type, input_type) {
        return true;
    }

    match (array_element_type(source_type), array_element_type(input_type)) {
        (Some(source), Some(input)) => is_type_compatible(source, input),
        _ => false,
    }
}

fn coercible_to(source_type: &str, input_type: &str) -> bool {
    matches!(
        (source_type, input_type),
        ("core:string", "core:directory")
            | ("core:string", "core:file")
            | ("core:directory", "core:string")
            | ("core:file", "core:string")
            | ("neuro:volume", "core:file")
            | ("neuro:volume", "core:string")
            | ("neuro:mask", "neuro:volume")
            | ("neuro:mask", "core:file")
            | ("neuro:mask", "core:string")
            | ("neuro:bids-dataset", "core:directory")
            | ("neuro:bids-dataset", "core:string")
    )
}

fn array_element_type(value: &str) -> Option<&str> {
    value
        .strip_prefix("core:array<")
        .and_then(|rest| rest.strip_suffix('>'))
}

fn valid_semver(value: &str) -> bool {
    let parts: Vec<&str> = value.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.chars().all(|ch| ch.is_ascii_digit()))
}

fn valid_reference(reference: &str) -> bool {
    if reference == "context" {
        return true;
    }
    if reference.starts_with("inputs.") || reference.starts_with("context.") {
        return reference.split('.').count() == 2;
    }
    if reference.starts_with("steps.") {
        let parts: Vec<&str> = reference.split('.').collect();
        return parts.len() == 4 && parts[2] == "outputs";
    }
    false
}

fn referenced_step(reference: &str) -> Option<&str> {
    let parts: Vec<&str> = reference.split('.').collect();
    if parts.len() == 4 && parts[0] == "steps" && parts[2] == "outputs" {
        Some(parts[1])
    } else {
        None
    }
}

fn context_has_field(fields: Option<&serde_json::Map<String, Value>>, field: &str) -> bool {
    fields
        .map(|fields| fields.contains_key(field))
        .unwrap_or(false)
}

fn finish(issues: Vec<ValidationIssue>) -> ValidationReport {
    let ok = issues.iter().all(|issue| issue.severity != "error");
    ValidationReport { ok, issues }
}

fn error(path: impl Into<String>, message: impl Into<String>) -> ValidationIssue {
    ValidationIssue {
        severity: "error".to_string(),
        path: Some(path.into()),
        message: message.into(),
    }
}

fn warning(path: impl Into<String>, message: impl Into<String>) -> ValidationIssue {
    ValidationIssue {
        severity: "warning".to_string(),
        path: Some(path.into()),
        message: message.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_minimal_workflow() {
        let workflow = serde_json::json!({
            "neuroflow": "0.1.0",
            "kind": "workflow",
            "id": "test/workflow",
            "version": "0.1.0",
            "description": "Minimal workflow",
            "inputs": { "dicom_dir": { "type": "neuro:dicom-folder", "description": "DICOM" } },
            "context": { "fields": { "outDir": { "type": "core:directory", "description": "Output" } } },
            "steps": {
                "convert": {
                    "tool": "dcm2niix",
                    "inputs": { "dicom_dir": { "ref": "inputs.dicom_dir" } },
                    "outputMappings": { "outDir": "outDir" }
                }
            },
            "outputs": { "outDir": { "type": "core:directory", "ref": "steps.convert.outputs.outDir" } }
        });
        let report = validate_workflow_value(&workflow);
        assert!(report.ok, "{report:?}");
    }
}
