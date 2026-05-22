#[tauri::command]
fn validate_workflow(workflow: serde_json::Value) -> Result<serde_json::Value, String> {
    let report = neuroflow_core::validate_workflow_value(&workflow);
    serde_json::to_value(report).map_err(|err| err.to_string())
}

#[tauri::command]
fn plan_workflow(workflow: serde_json::Value) -> Result<serde_json::Value, String> {
    let plan = neuroflow_core::plan_workflow_value(&workflow);
    serde_json::to_value(plan).map_err(|err| err.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![validate_workflow, plan_workflow])
        .run(tauri::generate_context!())
        .expect("error while running NeuroFlow");
}
