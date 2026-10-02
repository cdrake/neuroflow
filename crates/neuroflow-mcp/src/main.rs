//! neuroflow-mcp: a Model Context Protocol server for NeuroFlow (RFC 0009).
//!
//! Speaks MCP over stdio. See crates/neuroflow-mcp/README.md.

mod artifacts;
mod registry;
mod qualifiers;
#[cfg(test)]
mod qualifier_tests;
mod runtime;
mod schema;
mod server;
mod util;

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
}

const USAGE: &str = "\
neuroflow-mcp: MCP server for NeuroFlow tools and workflows (stdio)

USAGE:
    neuroflow-mcp --registry <DIR> [options]

OPTIONS:
    --registry <DIR>          Directory of NeuroFlow tool/workflow JSON (repeatable). Scanned recursively.
    --data-root <DIR>         Directory that file inputs may come from (repeatable).
    --sessions <DIR>          Where run sessions are written. Default: ~/.neuroflow/runs
    --spec <DIR>              neuroflow-spec checkout; exposes its schemas as resources.
    --interpreter <NAME=PATH> Interpreter location, e.g. node=/opt/homebrew/bin/node (repeatable).
    --step-timeout <SECS>     Kill a step that runs longer than this.
    --summary-max-mb <MB>     Largest voxel block to scan for intensity stats. Default: 512
    --check                   Load the registry, print what would be exposed, and exit.
    -h, --help                Show this help.
";

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut registry_dirs = Vec::new();
    let mut data_roots = Vec::new();
    let mut sessions: Option<PathBuf> = None;
    let mut spec_dir = None;
    let mut interpreters = HashMap::new();
    let mut step_timeout = None;
    let mut summary_max_bytes = 512 * 1024 * 1024;
    let mut check = false;

    let mut it = args.into_iter();
    while let Some(arg) = it.next() {
        let mut value = |flag: &str| it.next().unwrap_or_else(|| fail(&format!("{flag} needs a value")));
        match arg.as_str() {
            "--registry" => registry_dirs.push(PathBuf::from(value("--registry"))),
            "--data-root" => data_roots.push(PathBuf::from(value("--data-root"))),
            "--sessions" => sessions = Some(PathBuf::from(value("--sessions"))),
            "--spec" => spec_dir = Some(PathBuf::from(value("--spec"))),
            "--interpreter" => {
                let v = value("--interpreter");
                let (name, path) = v.split_once('=').unwrap_or_else(|| fail("--interpreter expects NAME=PATH"));
                if !registry::ALLOWED_INTERPRETERS.contains(&name) {
                    fail(&format!("interpreter {name} is not allowed ({})", registry::ALLOWED_INTERPRETERS.join(", ")));
                }
                interpreters.insert(name.to_string(), PathBuf::from(path));
            }
            "--step-timeout" => {
                let secs: u64 = value("--step-timeout").parse().unwrap_or_else(|_| fail("--step-timeout expects seconds"));
                step_timeout = Some(Duration::from_secs(secs));
            }
            "--summary-max-mb" => {
                let mb: u64 = value("--summary-max-mb").parse().unwrap_or_else(|_| fail("--summary-max-mb expects a number"));
                summary_max_bytes = mb * 1024 * 1024;
            }
            "--check" => check = true,
            "-h" | "--help" => {
                print!("{USAGE}");
                return;
            }
            other => fail(&format!("unknown argument {other}\n\n{USAGE}")),
        }
    }
    if registry_dirs.is_empty() {
        fail(&format!("at least one --registry directory is required\n\n{USAGE}"));
    }

    let sessions = sessions.unwrap_or_else(|| {
        std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir)
            .join(".neuroflow")
            .join("runs")
    });
    std::fs::create_dir_all(&sessions).unwrap_or_else(|e| fail(&format!("cannot create {}: {e}", sessions.display())));
    let sessions_root = sessions.canonicalize().unwrap_or(sessions);
    let data_roots = data_roots
        .into_iter()
        .map(|d| d.canonicalize().unwrap_or_else(|e| fail(&format!("--data-root {}: {e}", d.display()))))
        .collect();
    let spec_dir = spec_dir.map(|d: PathBuf| d.canonicalize().unwrap_or_else(|e| fail(&format!("--spec {}: {e}", d.display()))));

    let cfg = Config {
        registry_dirs,
        spec_dir,
        data_roots,
        sessions_root,
        interpreters,
        step_timeout,
        summary_max_bytes,
    };
    let registry = registry::Registry::load(&cfg.registry_dirs, &cfg.interpreters).unwrap_or_else(|e| fail(&e));
    for w in &registry.warnings {
        eprintln!("neuroflow-mcp: {w}");
    }

    if check {
        println!("sessions: {}", cfg.sessions_root.display());
        for root in &cfg.data_roots {
            println!("data root: {}", root.display());
        }
        for doc in &registry.docs {
            match (&doc.mcp_name, &doc.runnable) {
                (Some(name), _) => println!("exposed   {:<9} {name}  ({})", doc.kind.as_str(), doc.id),
                (None, Err(reason)) => println!("listed    {:<9} {}  (not runnable: {reason})", doc.kind.as_str(), doc.id),
                (None, Ok(())) => println!("listed    {:<9} {}  (not exposed)", doc.kind.as_str(), doc.id),
            }
        }
        return;
    }

    eprintln!(
        "neuroflow-mcp {}: {} documents, {} exposed; sessions in {}",
        env!("CARGO_PKG_VERSION"),
        registry.docs.len(),
        registry.docs.iter().filter(|d| d.mcp_name.is_some()).count(),
        cfg.sessions_root.display()
    );
    server::Server::new(cfg, registry).serve();
}

fn fail(msg: &str) -> ! {
    eprintln!("neuroflow-mcp: {msg}");
    std::process::exit(2);
}
