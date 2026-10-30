//! Unknown-field check for workflow documents.
//!
//! The spec schemas close most workflow declarations (`additionalProperties:
//! false`), so a misspelt field such as `optinal` makes a document invalid. The
//! core does not run a JSON Schema validator (it would make the WASM build about
//! fifteen times larger), so it checks the closed key sets directly. The lists
//! below follow `workflow.schema.json`, `common.schema.json` and
//! `events.schema.json`; `crates/neuroflow-conformance` fails when they drift
//! from the vendored schemas. Extension data lives under `extensions`, which is open.

use crate::{error, with_code, with_hint, ValidationIssue};
use serde_json::Value;

const ROOT: &[&str] = &[
    "$schema",
    "neuroflow",
    "kind",
    "id",
    "version",
    "description",
    "inputs",
    "context",
    "steps",
    "outputs",
    "errorPolicy",
    "extensions",
];
const CONTEXT: &[&str] = &["description", "fields"];
const CONTEXT_FIELD: &[&str] = &[
    "type",
    "description",
    "label",
    "heuristic",
    "dependsOn",
    "optional",
    "default",
    "enum",
    "min",
    "max",
    "liveWritable",
    "extensions",
    "formats",
    "space",
    "resolution",
    "density",
    "labelSystem",
];
const INPUT: &[&str] = &[
    "type",
    "description",
    "label",
    "optional",
    "default",
    "enum",
    "min",
    "max",
    "minItems",
    "maxItems",
    "formats",
    "space",
    "resolution",
    "density",
    "labelSystem",
    "extensions",
];
const STEP: &[&str] = &[
    "tool",
    "inputs",
    "outputMappings",
    "condition",
    "stage",
    "eventBindings",
    "awaitApproval",
    "fixLoop",
    "errorPolicy",
    "extensions",
];
const BINDING: &[&str] = &["ref", "constant"];
const STEP_ERROR_POLICY: &[&str] = &[
    "onError",
    "tolerateItemFailures",
    "requiredOutputs",
    "notify",
];
const TOLERATE_ITEM_FAILURES: &[&str] = &["max", "maxFraction", "minSuccesses"];
const FIX_LOOP: &[&str] = &["fixerStep", "maxIterations", "stopOn"];
const EVENT_BINDINGS: &[&str] = &["transport", "contextWrites", "subscribeTo"];
const SIBLING_SUBSCRIPTION: &[&str] = &["step", "types", "names", "inputBinding"];
const OUTPUT: &[&str] = &[
    "type",
    "ref",
    "description",
    "label",
    "optional",
    "formats",
    "space",
    "resolution",
    "density",
    "labelSystem",
    "extensions",
];
const WORKFLOW_ERROR_POLICY: &[&str] = &[
    "defaultOnError",
    "haltOnSteps",
    "onError",
    "notify",
    "completionStatus",
];

/// Each closed key set with the schema declaration it mirrors, as
/// `<file>#<JSON pointer>`. A binding is the union of its two `oneOf` branches.
pub const CLOSED_FIELDS: &[(&str, &[&str])] = &[
    ("workflow.schema.json#", ROOT),
    ("workflow.schema.json#/properties/context", CONTEXT),
    ("workflow.schema.json#/$defs/contextFieldDef", CONTEXT_FIELD),
    ("common.schema.json#/$defs/typeDeclaration", INPUT),
    ("workflow.schema.json#/$defs/stepDef", STEP),
    ("common.schema.json#/$defs/binding", BINDING),
    (
        "workflow.schema.json#/$defs/stepErrorPolicyDef",
        STEP_ERROR_POLICY,
    ),
    (
        "workflow.schema.json#/$defs/stepErrorPolicyDef/properties/tolerateItemFailures",
        TOLERATE_ITEM_FAILURES,
    ),
    ("workflow.schema.json#/$defs/fixLoopDef", FIX_LOOP),
    (
        "events.schema.json#/$defs/stepEventBindings",
        EVENT_BINDINGS,
    ),
    (
        "events.schema.json#/$defs/siblingSubscription",
        SIBLING_SUBSCRIPTION,
    ),
    ("workflow.schema.json#/$defs/outputDef", OUTPUT),
    (
        "workflow.schema.json#/$defs/workflowErrorPolicyDef",
        WORKFLOW_ERROR_POLICY,
    ),
];

/// Reports every key outside its declaration's closed set as an `unknown-field`
/// error. `default` and `delivery` on a workflow output are left to
/// `qualifiers::validate_document_qualifiers`, which explains them.
pub fn unknown_field_issues(workflow: &Value) -> Vec<ValidationIssue> {
    let mut issues = Vec::new();
    check(&mut issues, "", workflow, ROOT, &[]);
    if let Some(context) = workflow.get("context") {
        check(&mut issues, "context", context, CONTEXT, &[]);
        for (name, field) in entries(context.get("fields")) {
            check(
                &mut issues,
                &format!("context.fields.{name}"),
                field,
                CONTEXT_FIELD,
                &[],
            );
        }
    }
    for (name, input) in entries(workflow.get("inputs")) {
        check(&mut issues, &format!("inputs.{name}"), input, INPUT, &[]);
    }
    for (name, step) in entries(workflow.get("steps")) {
        let path = format!("steps.{name}");
        check(&mut issues, &path, step, STEP, &[]);
        for (input, binding) in entries(step.get("inputs")) {
            check(
                &mut issues,
                &format!("{path}.inputs.{input}"),
                binding,
                BINDING,
                &[],
            );
        }
        if let Some(policy) = step.get("errorPolicy") {
            check(
                &mut issues,
                &format!("{path}.errorPolicy"),
                policy,
                STEP_ERROR_POLICY,
                &[],
            );
            if let Some(tolerate) = policy.get("tolerateItemFailures") {
                let tolerate_path = format!("{path}.errorPolicy.tolerateItemFailures");
                check(
                    &mut issues,
                    &tolerate_path,
                    tolerate,
                    TOLERATE_ITEM_FAILURES,
                    &[],
                );
            }
        }
        if let Some(fix_loop) = step.get("fixLoop") {
            check(
                &mut issues,
                &format!("{path}.fixLoop"),
                fix_loop,
                FIX_LOOP,
                &[],
            );
        }
        if let Some(bindings) = step.get("eventBindings") {
            check(
                &mut issues,
                &format!("{path}.eventBindings"),
                bindings,
                EVENT_BINDINGS,
                &[],
            );
            let subscriptions = bindings.get("subscribeTo").and_then(Value::as_array);
            for (index, subscription) in subscriptions.into_iter().flatten().enumerate() {
                let subscription_path = format!("{path}.eventBindings.subscribeTo[{index}]");
                check(
                    &mut issues,
                    &subscription_path,
                    subscription,
                    SIBLING_SUBSCRIPTION,
                    &[],
                );
            }
        }
    }
    for (name, output) in entries(workflow.get("outputs")) {
        let explained = ["default", "delivery"];
        check(
            &mut issues,
            &format!("outputs.{name}"),
            output,
            OUTPUT,
            &explained,
        );
    }
    if let Some(policy) = workflow.get("errorPolicy") {
        check(
            &mut issues,
            "errorPolicy",
            policy,
            WORKFLOW_ERROR_POLICY,
            &[],
        );
    }
    issues
}

fn entries(value: Option<&Value>) -> impl Iterator<Item = (&String, &Value)> {
    value.and_then(Value::as_object).into_iter().flatten()
}

fn check(
    issues: &mut Vec<ValidationIssue>,
    path: &str,
    value: &Value,
    allowed: &[&str],
    explained: &[&str],
) {
    let Some(object) = value.as_object() else {
        return;
    };
    for key in object.keys() {
        if allowed.contains(&key.as_str()) || explained.contains(&key.as_str()) {
            continue;
        }
        let field_path = if path.is_empty() {
            key.clone()
        } else {
            format!("{path}.{key}")
        };
        let hint = match closest(key, allowed) {
            Some(near) => format!("Did you mean {near}?"),
            None => format!("Allowed fields: {}.", allowed.join(", ")),
        };
        issues.push(with_code(
            with_hint(error(field_path, format!("Unknown field {key}.")), hint),
            "unknown-field",
        ));
    }
}

/// The allowed key within two edits of `key`, if exactly one is closest.
fn closest<'a>(key: &str, allowed: &[&'a str]) -> Option<&'a str> {
    let mut best: Option<(usize, &str)> = None;
    let mut tied = false;
    for candidate in allowed {
        let distance = edit_distance(key, candidate);
        match best {
            Some((d, _)) if distance > d => {}
            Some((d, _)) if distance == d => tied = true,
            _ => {
                best = Some((distance, candidate));
                tied = false;
            }
        }
    }
    best.filter(|(d, _)| *d <= 2 && !tied).map(|(_, c)| c)
}

fn edit_distance(a: &str, b: &str) -> usize {
    let b: Vec<char> = b.chars().collect();
    let mut row: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.chars().enumerate() {
        let mut previous = row[0];
        row[0] = i + 1;
        for (j, cb) in b.iter().enumerate() {
            let substitution = previous + usize::from(ca != *cb);
            previous = row[j + 1];
            row[j + 1] = substitution.min(previous + 1).min(row[j] + 1);
        }
    }
    row[b.len()]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn suggests_the_closest_field() {
        assert_eq!(closest("optinal", OUTPUT), Some("optional"));
        assert_eq!(closest("lable", OUTPUT), Some("label"));
        assert_eq!(closest("zzzzzzzz", OUTPUT), None);
    }

    #[test]
    fn edit_distance_counts_insertions_deletions_and_substitutions() {
        assert_eq!(edit_distance("", "abc"), 3);
        assert_eq!(edit_distance("kitten", "sitting"), 3);
        assert_eq!(edit_distance("optional", "optional"), 0);
    }
}
