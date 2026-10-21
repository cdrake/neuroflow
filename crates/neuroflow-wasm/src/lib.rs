use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn validate_workflow_json(json: &str) -> Result<String, JsValue> {
    neuroflow_core::validate_workflow_str(json)
        .and_then(|report| serde_json::to_string(&report))
        .map_err(|err| JsValue::from_str(&err.to_string()))
}

/// Validate a workflow against a registry: `tools_json` is a JSON array of tool
/// documents, as `neuroflow-mcp` passes its registry to the same core function.
/// Without the tools, step tool ids, input completeness and binding types are
/// not checked.
#[wasm_bindgen]
pub fn validate_workflow_with_tools_json(json: &str, tools_json: &str) -> Result<String, JsValue> {
    validate_with_tools(json, tools_json).map_err(|err| JsValue::from_str(&err.to_string()))
}

#[wasm_bindgen]
pub fn plan_workflow_json(json: &str) -> Result<String, JsValue> {
    neuroflow_core::plan_workflow_str(json)
        .and_then(|plan| serde_json::to_string(&plan))
        .map_err(|err| JsValue::from_str(&err.to_string()))
}

fn validate_with_tools(json: &str, tools_json: &str) -> Result<String, serde_json::Error> {
    let workflow: serde_json::Value = serde_json::from_str(json)?;
    let tools: serde_json::Value = serde_json::from_str(tools_json)?;
    let report = neuroflow_core::validate_workflow_value_with_tools(&workflow, Some(&tools));
    serde_json::to_string(&report)
}

#[cfg(test)]
mod tests {
    use super::validate_with_tools;
    use serde_json::{json, Value};

    fn report(workflow: &Value, tools: &Value) -> Value {
        serde_json::from_str(
            &validate_with_tools(&workflow.to_string(), &tools.to_string()).unwrap(),
        )
        .unwrap()
    }

    #[test]
    fn checks_bindings_against_the_given_tools() {
        let tools = json!([{
            "neuroflow": "0.1.0",
            "kind": "tool",
            "id": "t/strip",
            "version": "0.1.0",
            "inputs": { "image": { "type": "neuro:volume" } },
            "outputs": { "brain": { "type": "neuro:volume" }, "report": { "type": "neuro:report" } }
        }]);
        let workflow = |source: &str| {
            json!({
                "neuroflow": "0.1.0",
                "kind": "workflow",
                "id": "w/two",
                "description": "Strip twice.",
                "version": "0.1.0",
                "inputs": { "t1": { "type": "neuro:volume" } },
                "steps": {
                    "a": { "tool": "t/strip", "inputs": { "image": { "ref": "inputs.t1" } } },
                    "b": { "tool": "t/strip", "inputs": { "image": { "ref": source } } }
                },
                "outputs": { "brain": { "type": "neuro:volume", "ref": "steps.b.outputs.brain" } }
            })
        };

        let good = report(&workflow("steps.a.outputs.brain"), &tools);
        assert_eq!(good["ok"], true, "{good}");
        let bad = report(&workflow("steps.a.outputs.report"), &tools);
        assert_eq!(bad["ok"], false);
        assert!(bad.to_string().contains("incompatible"), "{bad}");
    }

    #[test]
    fn rejects_malformed_tools_json() {
        assert!(validate_with_tools("{}", "not json").is_err());
    }
}
