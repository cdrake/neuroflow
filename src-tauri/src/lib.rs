mod host;

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

const MAX_ADAPTER_INPUT_BYTES: usize = 16 * 1024;

#[derive(Debug, Serialize)]
struct ConsoleToolResult {
    status: i32,
    stdout: String,
    stderr: String,
}

#[tauri::command]
fn validate_workflow(
    workflow: serde_json::Value,
    tools: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let report = neuroflow_core::validate_workflow_value_with_tools(&workflow, tools.as_ref());
    serde_json::to_value(report).map_err(|err| err.to_string())
}

#[tauri::command]
fn plan_workflow(workflow: serde_json::Value) -> Result<serde_json::Value, String> {
    let plan = neuroflow_core::plan_workflow_value(&workflow);
    serde_json::to_value(plan).map_err(|err| err.to_string())
}

#[tauri::command]
fn execute_console_tool(
    command_id: String,
    tool_id: String,
    inputs: serde_json::Value,
) -> Result<ConsoleToolResult, String> {
    validate_adapter_id("command id", &command_id)?;
    validate_adapter_id("tool id", &tool_id)?;

    let input_bytes = serde_json::to_vec(&inputs).map_err(|err| err.to_string())?;
    if input_bytes.len() > MAX_ADAPTER_INPUT_BYTES {
        return Err(format!(
            "Adapter inputs exceed the {} byte limit.",
            MAX_ADAPTER_INPUT_BYTES
        ));
    }

    match command_id.as_str() {
        "neuroflow.echo" => run_echo_adapter(&tool_id, &inputs),
        "neuroflow.dcm2niix.help" => run_dcm2niix_help_adapter(),
        _ => Err(format!("Command adapter {command_id} is not registered.")),
    }
}

fn run_echo_adapter(
    tool_id: &str,
    inputs: &serde_json::Value,
) -> Result<ConsoleToolResult, String> {
    let input_count = inputs.as_object().map_or(0, serde_json::Map::len);
    let output = Command::new("/bin/echo")
        .arg(format!(
            "NeuroFlow command adapter accepted {tool_id} with {input_count} input(s)."
        ))
        .output()
        .map_err(|err| format!("Failed to start command adapter: {err}"))?;

    Ok(console_result_from_output(output))
}

fn run_dcm2niix_help_adapter() -> Result<ConsoleToolResult, String> {
    let executable = resolve_executable("NEUROFLOW_DCM2NIIX", "dcm2niix")?;
    let output = Command::new(executable)
        .arg("-h")
        .output()
        .map_err(|err| format!("Failed to start dcm2niix adapter: {err}"))?;

    Ok(console_result_from_output(output))
}

fn console_result_from_output(output: Output) -> ConsoleToolResult {
    ConsoleToolResult {
        status: output.status.code().unwrap_or(1),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    }
}

fn resolve_executable(env_key: &str, binary: &str) -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os(env_key).map(PathBuf::from) {
        if path.is_file() {
            return Ok(path);
        }
        return Err(format!(
            "{env_key} points to {}, but that file does not exist.",
            path.display()
        ));
    }

    find_on_path(binary).ok_or_else(|| {
        format!("{binary} was not found on PATH. Set {env_key} to use this adapter.")
    })
}

fn find_on_path(binary: &str) -> Option<PathBuf> {
    let binary_path = Path::new(binary);
    if binary_path.components().count() > 1 && binary_path.is_file() {
        return Some(binary_path.to_path_buf());
    }

    std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths)
            .map(|path| path.join(binary))
            .find(|candidate| candidate.is_file())
    })
}

fn validate_adapter_id(label: &str, value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > 160 {
        return Err(format!("{label} must be 1-160 characters."));
    }
    if value.chars().all(is_adapter_id_char) {
        Ok(())
    } else {
        Err(format!("{label} contains unsupported characters."))
    }
}

fn is_adapter_id_char(value: char) -> bool {
    value.is_ascii_alphanumeric()
        || matches!(value, '.' | '-' | '_' | '/' | ':')
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            validate_workflow,
            plan_workflow,
            execute_console_tool,
            host::default_settings,
            host::check_environment,
            host::workflow_runnable,
            host::start_run,
            host::cancel_run,
            host::open_path,
            host::read_session_tail
        ])
        .run(tauri::generate_context!())
        .expect("error while running NeuroFlow");
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn registered_console_tool_executes_command() {
        let result = execute_console_tool(
            "neuroflow.echo".to_string(),
            "niivue.desktop.tools/dcm2niix".to_string(),
            json!({
                "dicom_dir": "/tmp/dicoms",
                "compress": "y"
            }),
        )
        .expect("registered command should execute");

        assert_eq!(result.status, 0);
        assert!(result.stderr.is_empty());
        assert!(result.stdout.contains("niivue.desktop.tools/dcm2niix"));
        assert!(result.stdout.contains("2 input(s)"));
    }

    #[test]
    fn unregistered_console_tool_is_rejected() {
        let error = execute_console_tool(
            "shell.anything".to_string(),
            "niivue.desktop.tools/dcm2niix".to_string(),
            json!({}),
        )
        .expect_err("unregistered command should be rejected");

        assert!(error.contains("not registered"));
    }

    #[test]
    fn dcm2niix_help_adapter_executes_when_available() {
        if find_on_path("dcm2niix").is_none() && std::env::var_os("NEUROFLOW_DCM2NIIX").is_none()
        {
            eprintln!("skipping dcm2niix adapter test because dcm2niix is not installed");
            return;
        }

        let result = execute_console_tool(
            "neuroflow.dcm2niix.help".to_string(),
            "niivue.desktop.tools/dcm2niix".to_string(),
            json!({}),
        )
        .expect("dcm2niix help command should execute");

        assert_eq!(result.status, 0);
        assert!(result.stdout.contains("dcm2niiX version"));
        assert!(result.stdout.contains("usage: dcm2niix"));
    }
}
