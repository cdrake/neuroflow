//! neuroflow-mcp as a library: the registry, runtime and MCP server behind the
//! `neuroflow-mcp` binary, reusable by other hosts (the Tauri desktop app runs
//! workflows in-process through `runtime::run_workflow`).

pub mod artifacts;
pub mod qualifiers;
#[cfg(test)]
mod qualifier_tests;
pub mod registry;
pub mod runtime;
pub mod schema;
pub mod server;
pub mod util;

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

pub struct Config {
    pub registry_dirs: Vec<PathBuf>,
    pub spec_dir: Option<PathBuf>,
    /// Canonical directories that artifact inputs may come from.
    pub data_roots: Vec<PathBuf>,
    /// Canonical directory holding one session directory per run.
    pub sessions_root: PathBuf,
    pub interpreters: HashMap<String, PathBuf>,
    pub step_timeout: Option<Duration>,
    pub summary_max_bytes: u64,
    /// Whether this host can run tools that open a window and wait for a
    /// person (`uiApp` launches). The desktop app can; the stdio MCP server
    /// cannot, because a client's request would block on a window nobody is
    /// watching. Such tools are listed but not runnable on a non-interactive host.
    pub interactive: bool,
}
