use serde::{Deserialize, Serialize};
use serde_json::Value;

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

    if root
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .is_empty()
    {
        issues.push(error("id", "Workflow id is required."));
    }

    let context_fields = root
        .get("context")
        .and_then(|v| v.get("fields"))
        .and_then(Value::as_object);

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

        if step_obj
            .get("tool")
            .and_then(Value::as_str)
            .unwrap_or("")
            .is_empty()
        {
            issues.push(error(format!("{path}.tool"), "Step tool is required."));
        }

        if let Some(inputs) = step_obj.get("inputs").and_then(Value::as_object) {
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
                    } else if let Some(field) = reference.strip_prefix("context.") {
                        if !context_has_field(context_fields, field) {
                            issues.push(warning(
                                binding_path,
                                format!(
                                    "Reference {reference} points to an undeclared context field."
                                ),
                            ));
                        }
                    } else if let Some(ref_step) = referenced_step(reference) {
                        if !steps.contains_key(ref_step) {
                            issues.push(error(
                                binding_path,
                                format!("Reference {reference} points to an unknown step."),
                            ));
                        }
                    }
                }
            }
        }

        if let Some(mappings) = step_obj.get("outputMappings").and_then(Value::as_object) {
            for (_, field_value) in mappings {
                let Some(field) = field_value.as_str() else {
                    issues.push(error(
                        format!("{path}.outputMappings"),
                        "Output mapping target must be a context field name.",
                    ));
                    continue;
                };
                if !context_has_field(context_fields, field) {
                    issues.push(warning(
                        format!("{path}.outputMappings"),
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
