pub mod qualifiers;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ValidationIssue {
    pub severity: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// Optional repair hint, e.g. the valid alternatives for an unresolved name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
    /// RFC 0010 comparison outcome for a qualifier issue. `requires-runtime-check`
    /// marks a binding the executor must resolve from artifact evidence; it is
    /// what makes a workflow conditional, independent of the message wording.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome: Option<qualifiers::Compatibility>,
    /// Stable identifier of the check that raised the issue, e.g. `optional-output`.
    /// Unlike `message`, it does not change between releases, so callers can
    /// recognise an issue without matching its wording.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
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
    let mut issues = qualifiers::validate_document_qualifiers(workflow);

    let Some(root) = workflow.as_object() else {
        return ValidationReport {
            ok: false,
            issues: vec![ValidationIssue {
                severity: "error".to_string(),
                path: None,
                message: "Workflow document must be a JSON object.".to_string(),
                hint: None,
                outcome: None,
                code: None,
            }],
        };
    };

    if root.get("kind").and_then(Value::as_str) != Some("workflow") {
        issues.push(error("kind", "Document kind must be workflow."));
    }

    if !is_supported_spec_version(root.get("neuroflow").and_then(Value::as_str)) {
        issues.push(error(
            "neuroflow",
            "Workflow must target NeuroFlow spec version 0.1.0, 0.1.1 or 0.1.2.",
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
    if let Some(fields) = context_fields {
        for (name, declaration) in fields {
            if declaration.get("default").is_some() {
                append_qualifier_issues(
                    &mut issues,
                    &format!("context.fields.{name}.default"),
                    &serde_json::json!({}),
                    declaration,
                    None,
                    None,
                );
            }
        }
    }
    let tool_registry = collect_tool_registry(tools);

    let steps = root.get("steps").and_then(Value::as_object);
    let Some(steps) = steps else {
        issues.push(error("steps", "Workflow steps must be an object."));
        return finish(issues);
    };

    let referenced_tools: std::collections::HashSet<_> = steps
        .values()
        .filter_map(|step| step.get("tool").and_then(Value::as_str))
        .collect();
    if let Some(tools) = tools {
        for reference in referenced_tools {
            if let Some(tool) = qualifiers::tool(tools, reference) {
                for mut issue in qualifiers::validate_document_qualifiers(tool) {
                    issue.path = Some(format!(
                        "tools.{reference}.{}",
                        issue.path.unwrap_or_default()
                    ));
                    issues.push(issue);
                }
            }
        }
    }

    for (step_name, step) in steps {
        let path = format!("steps.{step_name}");
        let Some(step_obj) = step.as_object() else {
            issues.push(error(path, "Step must be an object."));
            continue;
        };

        let tool_ref = step_obj.get("tool").and_then(Value::as_str).unwrap_or("");
        if tool_ref.is_empty() {
            issues.push(error(format!("{path}.tool"), "Step tool is required."));
        }
        let tool = tool_registry.get(tool_ref);
        if !tool_registry.is_empty() && !tool_ref.is_empty() && tool.is_none() {
            issues.push(with_hint(
                error(
                    format!("{path}.tool"),
                    format!("Step references unknown tool {tool_ref}."),
                ),
                similar_tools_hint(tool_ref, &tool_registry),
            ));
        }

        if let Some(stage) = step_obj.get("stage") {
            let known = stage.as_str().map(is_known_stage).unwrap_or(false);
            if !known {
                issues.push(warning(
                    format!("{path}.stage"),
                    format!(
                        "Stage is not a recognized NeuroFlow stage (expected one of {}).",
                        KNOWN_STAGES.join(", ")
                    ),
                ));
            }
        }

        let inputs = step_obj.get("inputs").and_then(Value::as_object);
        let Some(inputs) = inputs else {
            issues.push(error(
                format!("{path}.inputs"),
                "Step inputs must be an object.",
            ));
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
                        format!(
                            "Required input {input_name} for {} is not satisfied.",
                            tool.name
                        ),
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

            if has_constant {
                if let Some(input_def) = tool.and_then(|tool| tool.inputs.get(input_name)) {
                    append_qualifier_issues(
                        &mut issues,
                        &binding_path,
                        &serde_json::json!({}),
                        input_def,
                        None,
                        None,
                    );
                    let count = match &binding_obj["constant"] {
                        Value::Array(items) => Some(items.len()),
                        _ => Some(1),
                    };
                    if let Some(issue) =
                        item_count_issue(input_name, input_def, count, &binding_path)
                    {
                        issues.push(issue);
                    }
                }
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
                        let known: Vec<&str> = steps.keys().map(String::as_str).collect();
                        issues.push(with_hint(
                            error(
                                binding_path.clone(),
                                format!("Reference {reference} points to an unknown step."),
                            ),
                            format!("Declared steps: {}.", known.join(", ")),
                        ));
                        continue;
                    }
                    if let Some(issue) =
                        undeclared_step_output(reference, &binding_path, steps, &tool_registry)
                    {
                        issues.push(issue);
                        continue;
                    }
                }

                if let Some(tool) = tool {
                    if let Some(input_def) = tool.inputs.get(input_name) {
                        let resolved = qualifiers::resolve_qualifiers(
                            reference,
                            workflow,
                            tools.unwrap_or(&Value::Null),
                        );
                        append_qualifier_issues(
                            &mut issues,
                            &binding_path,
                            &resolved.declaration,
                            input_def,
                            resolved.space_identity.as_deref(),
                            resolved.space_identity.as_deref(),
                        );
                        if let Some(source_type) =
                            resolve_ref_type(reference, root, steps, &tool_registry)
                        {
                            // A single value counts as one item; an array's length is
                            // only known at run time.
                            let count = array_element_type(&source_type).is_none().then_some(1);
                            if let Some(issue) =
                                item_count_issue(input_name, input_def, count, &binding_path)
                            {
                                issues.push(issue);
                            }
                        }
                        if required_input(input_def) {
                            if let Some(issue) = optional_step_output(
                                reference,
                                &binding_path,
                                &format!("required input {input_name}"),
                                steps,
                                &tool_registry,
                            ) {
                                issues.push(issue);
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
                if let Some(target) = context_fields.and_then(|fields| fields.get(field)) {
                    let source = qualifiers::resolve_qualifiers(
                        &format!("steps.{step_name}.outputs.{output_name}"),
                        workflow,
                        tools.unwrap_or(&Value::Null),
                    );
                    append_qualifier_issues(
                        &mut issues,
                        &format!("{path}.outputMappings.{output_name}"),
                        &source.declaration,
                        target,
                        source.space_identity.as_deref(),
                        None,
                    );
                } else {
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
                append_qualifier_issues(
                    &mut issues,
                    &format!("outputs.{output_name}.ref"),
                    &serde_json::json!({}),
                    output,
                    None,
                    None,
                );
                continue;
            }
            if let Some(issue) = undeclared_step_output(
                reference,
                &format!("outputs.{output_name}.ref"),
                steps,
                &tool_registry,
            ) {
                issues.push(issue);
                continue;
            }
            let Some(_source_type) = resolve_ref_type(reference, root, steps, &tool_registry)
            else {
                issues.push(error(
                    format!("outputs.{output_name}.ref"),
                    format!("Workflow output references unknown value {reference}."),
                ));
                continue;
            };
            if let Some(issue) = optional_step_output(
                reference,
                &format!("outputs.{output_name}.ref"),
                &format!("workflow output {output_name}"),
                steps,
                &tool_registry,
            ) {
                issues.push(issue);
            }
            let resolved =
                qualifiers::resolve_qualifiers(reference, workflow, tools.unwrap_or(&Value::Null));
            append_qualifier_issues(
                &mut issues,
                &format!("outputs.{output_name}.ref"),
                &resolved.declaration,
                output,
                resolved.space_identity.as_deref(),
                resolved.space_identity.as_deref(),
            );
        }
    } else {
        issues.push(error("outputs", "Workflow outputs must be an object."));
    }

    finish(issues)
}

fn append_qualifier_issues(
    issues: &mut Vec<ValidationIssue>,
    path: &str,
    source: &Value,
    target: &Value,
    source_identity: Option<&str>,
    target_identity: Option<&str>,
) {
    for check in qualifiers::compare_qualifiers(source, target, source_identity, target_identity) {
        match check.outcome {
            qualifiers::Compatibility::Compatible => {}
            qualifiers::Compatibility::Incompatible => {
                issues.push(with_outcome(error(path, check.message), check.outcome))
            }
            qualifiers::Compatibility::RequiresRuntimeCheck => {
                issues.push(with_outcome(warning(path, check.message), check.outcome))
            }
        }
    }
}

/// Step ids in dependency order, using document order as the tie-breaker.
///
/// Document order is the authorial order when `serde_json` preserves it (as
/// `neuroflow-mcp` does) and key order otherwise.
pub fn step_order(workflow: &Value) -> Result<Vec<String>, String> {
    let steps = workflow
        .get("steps")
        .and_then(Value::as_object)
        .ok_or("workflow has no steps object")?;
    let ids: Vec<String> = steps.keys().cloned().collect();
    let mut deps: HashMap<&str, HashSet<String>> = HashMap::new();
    for (id, step) in steps {
        let mut set = HashSet::new();
        for binding in step
            .get("inputs")
            .and_then(Value::as_object)
            .into_iter()
            .flatten()
            .map(|(_, b)| b)
        {
            if let Some(reference) = binding.get("ref").and_then(Value::as_str) {
                let parts: Vec<&str> = reference.split('.').collect();
                if parts.len() == 4 && parts[0] == "steps" {
                    set.insert(parts[1].to_string());
                }
            }
        }
        deps.insert(id, set);
    }
    let mut done: Vec<String> = Vec::new();
    while done.len() < ids.len() {
        let next = ids.iter().find(|id| {
            !done.contains(id)
                && deps[id.as_str()]
                    .iter()
                    .all(|d| done.contains(d) || !ids.contains(d))
        });
        match next {
            Some(id) => done.push(id.clone()),
            None => {
                let stuck: Vec<&str> = ids
                    .iter()
                    .filter(|id| !done.contains(id))
                    .map(String::as_str)
                    .collect();
                return Err(format!(
                    "dependency cycle among steps: {}",
                    stuck.join(", ")
                ));
            }
        }
    }
    Ok(done)
}

/// Plan steps follow [`step_order`]; a workflow with a dependency cycle keeps
/// document order, since it cannot run.
pub fn plan_workflow_value(workflow: &Value) -> WorkflowPlan {
    let workflow_id = workflow
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string();

    let order = step_order(workflow).ok();
    let steps = workflow
        .get("steps")
        .and_then(Value::as_object)
        .map(|steps| {
            let ordered: Vec<(&String, &Value)> = match &order {
                Some(order) => order
                    .iter()
                    .filter_map(|id| steps.get_key_value(id))
                    .collect(),
                None => steps.iter().collect(),
            };
            ordered
                .into_iter()
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
        let name = tool_obj.get("name").and_then(Value::as_str).unwrap_or(id);
        let contract = ToolContract {
            name,
            inputs,
            outputs,
        };
        registry.insert(id.to_string(), contract);
        registry.insert(name.to_string(), contract);
        if let Some(version) = tool_obj.get("version").and_then(Value::as_str) {
            registry.insert(format!("{id}@{version}"), contract);
            registry.insert(format!("{name}@{version}"), contract);
        }
    }

    registry
}

fn required_input(input_def: &Value) -> bool {
    !input_def
        .get("optional")
        .and_then(Value::as_bool)
        .unwrap_or(false)
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

/// When `reference` is `steps.<s>.outputs.<o>`, the step's tool is known, and
/// the tool does not declare output `<o>`, return an error listing the declared
/// outputs so the author (human or agent) can repair it in one edit.
fn undeclared_step_output(
    reference: &str,
    path: &str,
    steps: &serde_json::Map<String, Value>,
    tools: &HashMap<String, ToolContract<'_>>,
) -> Option<ValidationIssue> {
    let parts: Vec<&str> = reference.split('.').collect();
    let ["steps", step_name, "outputs", output_name] = parts.as_slice() else {
        return None;
    };
    let tool_ref = steps.get(*step_name)?.get("tool").and_then(Value::as_str)?;
    let tool = tools.get(tool_ref)?;
    if tool.outputs.contains_key(*output_name) {
        return None;
    }
    let declared: Vec<&str> = tool.outputs.keys().map(String::as_str).collect();
    Some(with_hint(
        error(
            path.to_string(),
            format!(
                "Reference {reference} does not resolve: tool {} has no output {output_name}.",
                tool.name
            ),
        ),
        format!("Declared outputs: {}.", declared.join(", ")),
    ))
}

/// When `reference` is `steps.<s>.outputs.<o>` and the step's tool declares
/// `<o>` optional, warn that `target` may be left without a value. A warning,
/// not an error: the tool can still produce the output, e.g. on multi-shell data.
fn optional_step_output(
    reference: &str,
    path: &str,
    target: &str,
    steps: &serde_json::Map<String, Value>,
    tools: &HashMap<String, ToolContract<'_>>,
) -> Option<ValidationIssue> {
    let parts: Vec<&str> = reference.split('.').collect();
    let ["steps", step_name, "outputs", output_name] = parts.as_slice() else {
        return None;
    };
    let tool_ref = steps.get(*step_name)?.get("tool").and_then(Value::as_str)?;
    let tool = tools.get(tool_ref)?;
    let output = tool.outputs.get(*output_name)?;
    if !output
        .get("optional")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return None;
    }
    Some(with_code(
        warning(
            path.to_string(),
            format!(
                "Output {output_name} of {} is optional, so {target} may have no value when the step finishes.",
                tool.name
            ),
        ),
        "optional-output",
    ))
}

/// `minItems`/`maxItems` of an array input, when it declares either.
pub fn item_bounds(input_def: &Value) -> Option<(Option<u64>, Option<u64>)> {
    array_element_type(input_def.get("type").and_then(Value::as_str)?)?;
    let min = input_def.get("minItems").and_then(Value::as_u64);
    let max = input_def.get("maxItems").and_then(Value::as_u64);
    (min.is_some() || max.is_some()).then_some((min, max))
}

/// The item count an array input accepts, e.g. "at least 2 items".
pub fn describe_item_bounds(min: Option<u64>, max: Option<u64>) -> String {
    let items = |n: u64| format!("{n} item{}", if n == 1 { "" } else { "s" });
    match (min, max) {
        (Some(min), Some(max)) if min == max => format!("exactly {}", items(min)),
        (Some(min), Some(max)) => format!("between {min} and {}", items(max)),
        (Some(min), None) => format!("at least {}", items(min)),
        (None, Some(max)) => format!("at most {}", items(max)),
        (None, None) => "any number of items".to_string(),
    }
}

/// Check the number of items bound to an array input against its
/// `minItems`/`maxItems`. `count` is `None` when the binding is an array whose
/// length is only known at run time, which is a warning rather than an error.
fn item_count_issue(
    input_name: &str,
    input_def: &Value,
    count: Option<usize>,
    path: &str,
) -> Option<ValidationIssue> {
    let (min, max) = item_bounds(input_def)?;
    let bounds = describe_item_bounds(min, max);
    let Some(count) = count else {
        return Some(warning(
            path.to_string(),
            format!(
                "Input {input_name} takes {bounds}; the array's length is checked at run time."
            ),
        ));
    };
    let count = count as u64;
    if min.is_some_and(|min| count < min) || max.is_some_and(|max| count > max) {
        return Some(error(
            path.to_string(),
            format!("Input {input_name} takes {bounds}, but the binding supplies {count}."),
        ));
    }
    None
}

fn similar_tools_hint(tool_ref: &str, tools: &HashMap<String, ToolContract<'_>>) -> String {
    let needle = tool_ref
        .rsplit('/')
        .next()
        .unwrap_or(tool_ref)
        .to_ascii_lowercase();
    let mut ids: Vec<&str> = tools
        .keys()
        .map(String::as_str)
        .filter(|id| id.contains('/'))
        .collect();
    ids.sort_unstable();
    ids.dedup();
    let similar: Vec<&str> = ids
        .iter()
        .copied()
        .filter(|id| {
            let last = id.rsplit('/').next().unwrap_or(id).to_ascii_lowercase();
            !needle.is_empty() && (last.contains(&needle) || needle.contains(&last))
        })
        .collect();
    if similar.is_empty() {
        format!("Known tools: {}.", ids.join(", "))
    } else {
        format!("Did you mean: {}?", similar.join(", "))
    }
}

/// The RFC 0010 axes evaluated by both static validation and execution.
pub const TYPE_QUALIFIERS: &[&str] = &["formats", "space", "resolution", "density", "labelSystem"];

pub fn declared_qualifiers(declaration: &Value) -> Vec<&'static str> {
    TYPE_QUALIFIERS
        .iter()
        .copied()
        .filter(|q| declaration.get(q).is_some())
        .collect()
}

fn declaration_type(value: &Value) -> Option<String> {
    value
        .get("type")
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// Whether a value of `source_type` may be bound to an input of `input_type`.
/// Mirrors `src/domain/typeCompatibility.ts`; keep the two coercion tables in sync.
pub fn is_type_compatible(source_type: &str, input_type: &str) -> bool {
    if source_type == input_type {
        return true;
    }

    if coercible_to(source_type, input_type) {
        return true;
    }

    match (
        array_element_type(source_type),
        array_element_type(input_type),
    ) {
        (Some(source), Some(input)) => is_type_compatible(source, input),
        // A single value fills a one-element array input.
        (None, Some(input)) => is_type_compatible(source_type, input),
        _ => false,
    }
}

/// Allowed implicit coercions, keyed by source type. Mirrors
/// `COERCION_RULES` in `src/domain/typeCompatibility.ts`.
const COERCION_RULES: &[(&str, &[&str])] = &[
    ("core:string", &["core:directory", "core:file"]),
    ("core:directory", &["core:string"]),
    ("core:file", &["core:string"]),
    ("neuro:volume", &["core:file", "core:string"]),
    (
        "neuro:ome-zarr",
        &["neuro:ngff-zarr", "core:directory", "core:string"],
    ),
    (
        "neuro:ngff-zarr",
        &[
            "neuro:ome-zarr",
            "core:directory",
            "core:file",
            "core:json",
            "core:string",
        ],
    ),
    ("neuro:tract", &["core:file", "core:string"]),
    ("neuro:surface", &["core:file", "core:string"]),
    ("neuro:mask", &["neuro:volume", "core:file", "core:string"]),
    (
        "neuro:statmap",
        &["neuro:volume", "core:file", "core:string"],
    ),
    (
        "neuro:probseg",
        &["neuro:volume", "core:file", "core:string"],
    ),
    ("neuro:cifti", &["core:file", "core:string"]),
    ("neuro:gradient-table", &["core:file", "core:string"]),
    (
        "neuro:connectivity-matrix",
        &["core:tabular", "core:file", "core:string"],
    ),
    (
        "neuro:qc-metrics",
        &["core:json", "core:file", "core:string"],
    ),
    ("neuro:report", &["core:file", "core:string"]),
    ("core:tabular", &["core:file", "core:string"]),
    ("neuro:bids-dataset", &["core:directory", "core:string"]),
    (
        "neurovue:correction-patch",
        &["core:json", "core:file", "core:string"],
    ),
];

fn coercible_to(source_type: &str, input_type: &str) -> bool {
    COERCION_RULES
        .iter()
        .any(|(source, targets)| *source == source_type && targets.contains(&input_type))
}

/// Specification versions this runtime reads. `0.1.1` is `0.1.0` plus the
/// RFC 0010 type qualifiers; a document declares it when it carries any.
/// `0.1.2` adds `minItems`/`maxItems` on array declarations.
pub const SUPPORTED_SPEC_VERSIONS: &[&str] = &["0.1.0", "0.1.1", "0.1.2"];

/// Whether a document's `neuroflow` envelope value is one this runtime reads.
pub fn is_supported_spec_version(value: Option<&str>) -> bool {
    value.is_some_and(|v| SUPPORTED_SPEC_VERSIONS.contains(&v))
}

/// Element type of a `core:array<...>` type, or `None` for scalar types.
pub fn array_element_type(value: &str) -> Option<&str> {
    value
        .strip_prefix("core:array<")
        .and_then(|rest| rest.strip_suffix('>'))
}

/// Recognized workflow stages. Stages are an informal, opt-in discovery grouping
/// (see `docs/stages.md`); they are not load-bearing, so an unrecognized value is
/// only a warning, never an error.
const KNOWN_STAGES: [&str; 3] = ["ingest", "explore", "publish"];

fn is_known_stage(value: &str) -> bool {
    KNOWN_STAGES.contains(&value)
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
        hint: None,
        outcome: None,
        code: None,
    }
}

fn with_hint(mut issue: ValidationIssue, hint: impl Into<String>) -> ValidationIssue {
    issue.hint = Some(hint.into());
    issue
}

fn with_outcome(mut issue: ValidationIssue, outcome: qualifiers::Compatibility) -> ValidationIssue {
    issue.outcome = Some(outcome);
    issue
}

fn with_code(mut issue: ValidationIssue, code: &str) -> ValidationIssue {
    issue.code = Some(code.to_string());
    issue
}

fn warning(path: impl Into<String>, message: impl Into<String>) -> ValidationIssue {
    ValidationIssue {
        severity: "warning".to_string(),
        path: Some(path.into()),
        message: message.into(),
        hint: None,
        outcome: None,
        code: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plans_steps_in_dependency_order() {
        // Without preserve_order the steps object iterates by key, so key order
        // alone would list correct before denoise.
        let workflow = serde_json::json!({
            "id": "test/dwi",
            "steps": {
                "noddi": { "tool": "t/noddi", "inputs": { "dwi": { "ref": "steps.correct.outputs.dwi" } } },
                "correct": { "tool": "t/correct", "inputs": { "dwi": { "ref": "steps.gibbs.outputs.dwi" } } },
                "gibbs": { "tool": "t/gibbs", "inputs": { "dwi": { "ref": "steps.denoise.outputs.dwi" } } },
                "denoise": { "tool": "t/denoise", "inputs": { "dwi": { "ref": "inputs.dwi" } } }
            }
        });
        let ids: Vec<String> = plan_workflow_value(&workflow)
            .steps
            .into_iter()
            .map(|step| step.id)
            .collect();
        assert_eq!(ids, ["denoise", "gibbs", "correct", "noddi"]);
        assert_eq!(step_order(&workflow).unwrap(), ids);
    }

    #[test]
    fn plans_a_cycle_in_document_order() {
        let workflow = serde_json::json!({ "steps": {
            "a": { "tool": "t/a", "inputs": { "x": { "ref": "steps.b.outputs.y" } } },
            "b": { "tool": "t/b", "inputs": { "x": { "ref": "steps.a.outputs.y" } } }
        }});
        assert!(step_order(&workflow).unwrap_err().contains("cycle"));
        let ids: Vec<String> = plan_workflow_value(&workflow)
            .steps
            .into_iter()
            .map(|step| step.id)
            .collect();
        assert_eq!(ids, ["a", "b"]);
    }

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

    fn workflow_with_stage(stage: &str) -> Value {
        serde_json::json!({
            "neuroflow": "0.1.0",
            "kind": "workflow",
            "id": "test/workflow",
            "version": "0.1.0",
            "description": "Stage-tagged workflow",
            "inputs": { "dicom_dir": { "type": "neuro:dicom-folder", "description": "DICOM" } },
            "context": { "fields": { "outDir": { "type": "core:directory", "description": "Output" } } },
            "steps": {
                "convert": {
                    "tool": "dcm2niix",
                    "stage": stage,
                    "inputs": { "dicom_dir": { "ref": "inputs.dicom_dir" } },
                    "outputMappings": { "outDir": "outDir" }
                }
            },
            "outputs": { "outDir": { "type": "core:directory", "ref": "steps.convert.outputs.outDir" } }
        })
    }

    #[test]
    fn accepts_known_stage_without_issues() {
        let report = validate_workflow_value(&workflow_with_stage("ingest"));
        assert!(report.ok, "{report:?}");
        assert!(
            !report
                .issues
                .iter()
                .any(|issue| issue.path.as_deref() == Some("steps.convert.stage")),
            "known stage should not raise an issue: {report:?}"
        );
    }

    fn strip_segment_workflow(reference: &str) -> (Value, Value) {
        let workflow = serde_json::json!({
            "neuroflow": "0.1.0",
            "kind": "workflow",
            "id": "test/strip-segment",
            "version": "0.1.0",
            "description": "Two-step workflow",
            "inputs": { "t1": { "type": "neuro:volume", "description": "T1" } },
            "steps": {
                "strip": { "tool": "test.tools/strip", "inputs": { "t1": { "ref": "inputs.t1" } } },
                "segment": { "tool": "test.tools/segment", "inputs": { "brain": { "ref": reference } } }
            },
            "outputs": { "labels": { "type": "neuro:label-map", "ref": "steps.segment.outputs.labels" } }
        });
        let tools = serde_json::json!([
            {
                "id": "test.tools/strip",
                "inputs": { "t1": { "type": "neuro:volume" } },
                "outputs": { "brain_volume": { "type": "neuro:volume" }, "brain_mask": { "type": "neuro:mask" } }
            },
            {
                "id": "test.tools/segment",
                "inputs": { "brain": { "type": "neuro:volume" } },
                "outputs": { "labels": { "type": "neuro:label-map" } }
            }
        ]);
        (workflow, tools)
    }

    #[test]
    fn accepts_0_1_1_and_reports_unknown_qualified_inputs() {
        let tool = serde_json::json!({
            "neuroflow": "0.1.1", "kind": "tool", "id": "test/strip", "version": "1.0.0", "description": "Strip",
            "inputs": { "image": { "type": "neuro:volume", "description": "T1", "formats": ["nifti"], "space": "individual" } },
            "outputs": { "brain": { "type": "neuro:volume", "description": "Brain", "space": "inputs.image" } }
        });
        let workflow = serde_json::json!({
            "neuroflow": "0.1.1", "kind": "workflow", "id": "test/workflow", "version": "0.1.0", "description": "Qualified",
            "inputs": { "t1": { "type": "neuro:volume", "description": "T1" } },
            "steps": { "strip": { "tool": "test/strip", "inputs": { "image": { "ref": "inputs.t1" } } } },
            "outputs": { "brain": { "type": "neuro:volume", "ref": "steps.strip.outputs.brain" } }
        });
        let tools = serde_json::json!([tool]);
        let report = validate_workflow_value_with_tools(&workflow, Some(&tools));
        assert!(report.ok, "0.1.1 must be accepted: {report:?}");
        let warnings: Vec<_> = report
            .issues
            .iter()
            .filter(|i| i.severity == "warning")
            .collect();
        assert_eq!(
            warnings.len(),
            2,
            "one warning per declared qualifier: {report:?}"
        );
        assert!(warnings
            .iter()
            .all(|i| i.message.contains("requires a runtime check")));
        let mut old = workflow.clone();
        old["neuroflow"] = serde_json::json!("0.2.0");
        assert!(
            !validate_workflow_value_with_tools(&old, None).ok,
            "0.2.0 is not a supported version"
        );
    }

    #[test]
    fn rejects_undeclared_step_output_with_hint() {
        let (workflow, tools) = strip_segment_workflow("steps.strip.outputs.brain");
        let report = validate_workflow_value_with_tools(&workflow, Some(&tools));
        assert!(!report.ok, "{report:?}");
        let issue = report
            .issues
            .iter()
            .find(|issue| issue.path.as_deref() == Some("steps.segment.inputs.brain"))
            .expect("expected an unresolved-output error");
        assert_eq!(issue.severity, "error");
        let hint = issue.hint.as_deref().unwrap_or("");
        assert!(
            hint.contains("brain_volume") && hint.contains("brain_mask"),
            "{hint}"
        );
    }

    #[test]
    fn accepts_declared_step_output() {
        let (workflow, tools) = strip_segment_workflow("steps.strip.outputs.brain_volume");
        let report = validate_workflow_value_with_tools(&workflow, Some(&tools));
        assert!(report.ok, "{report:?}");
    }

    fn optional_output_warnings(
        workflow: &Value,
        tools: &Value,
    ) -> (ValidationReport, Vec<String>) {
        let report = validate_workflow_value_with_tools(workflow, Some(tools));
        let paths = report
            .issues
            .iter()
            .filter(|issue| {
                issue.severity == "warning" && issue.code.as_deref() == Some("optional-output")
            })
            .filter_map(|issue| issue.path.clone())
            .collect();
        (report, paths)
    }

    #[test]
    fn warns_when_an_optional_output_feeds_a_required_input() {
        let (workflow, mut tools) = strip_segment_workflow("steps.strip.outputs.brain_volume");
        tools[0]["outputs"]["brain_volume"]["optional"] = serde_json::json!(true);
        let (report, paths) = optional_output_warnings(&workflow, &tools);
        assert!(report.ok, "a warning, not an error: {report:?}");
        assert_eq!(paths, ["steps.segment.inputs.brain"]);

        tools[1]["inputs"]["brain"]["optional"] = serde_json::json!(true);
        let (_, paths) = optional_output_warnings(&workflow, &tools);
        assert!(paths.is_empty(), "an optional input can go unfilled");

        tools[1]["inputs"]["brain"]["optional"] = serde_json::json!(false);
        tools[1]["inputs"]["brain"]["default"] = serde_json::json!("brain.nii.gz");
        let (_, paths) = optional_output_warnings(&workflow, &tools);
        assert!(paths.is_empty(), "a default fills the input");
    }

    #[test]
    fn warns_when_a_workflow_output_is_optional() {
        let (workflow, mut tools) = strip_segment_workflow("steps.strip.outputs.brain_volume");
        let (_, paths) = optional_output_warnings(&workflow, &tools);
        assert!(paths.is_empty(), "{paths:?}");

        tools[1]["outputs"]["labels"]["optional"] = serde_json::json!(true);
        let (report, paths) = optional_output_warnings(&workflow, &tools);
        assert!(report.ok, "a warning, not an error: {report:?}");
        assert_eq!(paths, ["outputs.labels.ref"]);
    }

    #[test]
    fn issue_codes_serialize_only_when_set() {
        let (workflow, mut tools) = strip_segment_workflow("steps.strip.outputs.brain_volume");
        tools[0]["outputs"]["brain_volume"]["optional"] = serde_json::json!(true);
        let (report, _) = optional_output_warnings(&workflow, &tools);
        let issues = serde_json::to_value(&report).unwrap()["issues"].clone();
        let codes: Vec<&Value> = issues
            .as_array()
            .unwrap()
            .iter()
            .map(|issue| &issue["code"])
            .collect();
        assert_eq!(codes, [&serde_json::json!("optional-output")], "{issues}");

        let error = serde_json::to_value(error("steps.a", "broken")).unwrap();
        assert!(error.get("code").is_none(), "{error}");
    }

    #[test]
    fn a_single_volume_fills_an_array_input() {
        let (workflow, mut tools) = strip_segment_workflow("steps.strip.outputs.brain_volume");
        tools[1]["inputs"]["brain"]["type"] = serde_json::json!("core:array<neuro:volume>");
        let report = validate_workflow_value_with_tools(&workflow, Some(&tools));
        assert!(report.ok, "{report:?}");

        tools[1]["inputs"]["brain"]["type"] = serde_json::json!("core:array<neuro:mask>");
        let report = validate_workflow_value_with_tools(&workflow, Some(&tools));
        assert!(!report.ok, "a volume is not a mask: {report:?}");
    }

    /// Item counts are a 0.1.2 feature, so the tool declares that version.
    fn item_count_issues(workflow: &Value, tools: &Value) -> (ValidationReport, Vec<String>) {
        let mut tools = tools.clone();
        tools[1]["neuroflow"] = serde_json::json!("0.1.2");
        let report = validate_workflow_value_with_tools(workflow, Some(&tools));
        let messages = report
            .issues
            .iter()
            .filter(|issue| issue.message.starts_with("Input brain takes"))
            .map(|issue| format!("{}: {}", issue.severity, issue.message))
            .collect();
        (report, messages)
    }

    #[test]
    fn checks_the_item_count_of_an_array_input() {
        let (mut workflow, mut tools) = strip_segment_workflow("steps.strip.outputs.brain_volume");
        tools[1]["inputs"]["brain"] =
            serde_json::json!({ "type": "core:array<neuro:volume>", "maxItems": 3 });
        let (report, messages) = item_count_issues(&workflow, &tools);
        assert!(report.ok, "{report:?}");
        assert!(messages.is_empty(), "{messages:?}");

        tools[1]["inputs"]["brain"]["minItems"] = serde_json::json!(2);
        let (report, messages) = item_count_issues(&workflow, &tools);
        assert!(!report.ok);
        assert_eq!(
            messages,
            ["error: Input brain takes between 2 and 3 items, but the binding supplies 1."]
        );

        workflow["steps"]["segment"]["inputs"]["brain"] =
            serde_json::json!({ "constant": ["/a", "/b", "/c", "/d"] });
        let (_, messages) = item_count_issues(&workflow, &tools);
        assert_eq!(
            messages,
            ["error: Input brain takes between 2 and 3 items, but the binding supplies 4."]
        );

        workflow["steps"]["segment"]["inputs"]["brain"] =
            serde_json::json!({ "constant": ["/a", "/b"] });
        let (report, messages) = item_count_issues(&workflow, &tools);
        assert!(messages.is_empty(), "{report:?}");
    }

    #[test]
    fn warns_that_an_array_bound_to_an_array_input_is_counted_at_run_time() {
        let (mut workflow, mut tools) = strip_segment_workflow("inputs.images");
        workflow["inputs"]["images"] = serde_json::json!({ "type": "core:array<neuro:volume>" });
        tools[1]["inputs"]["brain"] =
            serde_json::json!({ "type": "core:array<neuro:volume>", "minItems": 2, "maxItems": 2 });
        let (report, messages) = item_count_issues(&workflow, &tools);
        assert!(report.ok, "{report:?}");
        assert_eq!(
            messages,
            ["warning: Input brain takes exactly 2 items; the array's length is checked at run time."]
        );
    }

    #[test]
    fn item_counts_require_0_1_2() {
        let (workflow, mut tools) = strip_segment_workflow("steps.strip.outputs.brain_volume");
        tools[1]["neuroflow"] = serde_json::json!("0.1.1");
        tools[1]["inputs"]["brain"] =
            serde_json::json!({ "type": "core:array<neuro:volume>", "maxItems": 3 });
        let report = validate_workflow_value_with_tools(&workflow, Some(&tools));
        assert!(
            report
                .issues
                .iter()
                .any(|issue| issue.message == "Item counts require neuroflow 0.1.2."),
            "{report:?}"
        );
    }

    #[test]
    fn ignores_item_counts_on_a_scalar_input() {
        let (workflow, mut tools) = strip_segment_workflow("steps.strip.outputs.brain_volume");
        tools[1]["inputs"]["brain"]["minItems"] = serde_json::json!(2);
        let (report, messages) = item_count_issues(&workflow, &tools);
        assert!(report.ok, "{report:?}");
        assert!(messages.is_empty(), "{messages:?}");
    }

    #[test]
    fn coercion_table_matches_typescript_rules() {
        assert!(is_type_compatible("neuro:statmap", "neuro:volume"));
        assert!(is_type_compatible(
            "core:array<neuro:probseg>",
            "core:array<neuro:volume>"
        ));
        assert!(!is_type_compatible("neuro:volume", "neuro:mask"));
        assert!(is_type_compatible(
            "neuro:volume",
            "core:array<neuro:volume>"
        ));
        assert!(is_type_compatible("neuro:mask", "core:array<neuro:volume>"));
        assert!(!is_type_compatible(
            "neuro:volume",
            "core:array<neuro:mask>"
        ));
        assert!(!is_type_compatible(
            "core:array<neuro:volume>",
            "neuro:volume"
        ));
    }

    #[test]
    fn warns_on_unknown_stage_but_stays_valid() {
        let report = validate_workflow_value(&workflow_with_stage("teleport"));
        assert!(
            report.ok,
            "unknown stage must not be a hard error: {report:?}"
        );
        let issue = report
            .issues
            .iter()
            .find(|issue| issue.path.as_deref() == Some("steps.convert.stage"))
            .expect("expected a stage warning");
        assert_eq!(issue.severity, "warning");
    }
}
