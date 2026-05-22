use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn validate_workflow_json(json: &str) -> Result<String, JsValue> {
    neuroflow_core::validate_workflow_str(json)
        .and_then(|report| serde_json::to_string(&report))
        .map_err(|err| JsValue::from_str(&err.to_string()))
}

#[wasm_bindgen]
pub fn plan_workflow_json(json: &str) -> Result<String, JsValue> {
    neuroflow_core::plan_workflow_str(json)
        .and_then(|plan| serde_json::to_string(&plan))
        .map_err(|err| JsValue::from_str(&err.to_string()))
}
