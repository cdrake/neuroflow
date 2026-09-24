//! `neuroflow://` resources: artifact descriptors, summaries (not bytes), raw
//! reads for small files, logs, provenance, catalog documents, and schemas
//! (RFC 0009 section 5).

use crate::registry::Registry;
use crate::util::{base64, pct_decode, pct_encode};
use crate::Config;
use flate2::read::GzDecoder;
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

const RAW_BINARY_MAX: u64 = 1024 * 1024;
const RAW_TEXT_MAX: u64 = 4 * 1024 * 1024;

pub fn media_type(path: &str) -> &'static str {
    let p = path.to_ascii_lowercase();
    if Path::new(path).is_dir() {
        return "inode/directory";
    }
    match () {
        _ if p.ends_with(".nii.gz") || p.ends_with(".gz") => "application/gzip",
        _ if p.ends_with(".nii") => "application/octet-stream",
        _ if p.ends_with(".json") => "application/json",
        _ if p.ends_with(".tsv") => "text/tab-separated-values",
        _ if p.ends_with(".csv") => "text/csv",
        _ if p.ends_with(".html") || p.ends_with(".htm") => "text/html",
        _ if p.ends_with(".txt") || p.ends_with(".log") || p.ends_with(".stdout") || p.ends_with(".stderr") => "text/plain",
        _ if p.ends_with(".md") => "text/markdown",
        _ if p.ends_with(".png") => "image/png",
        _ if p.ends_with(".jpg") || p.ends_with(".jpeg") => "image/jpeg",
        _ if p.ends_with(".pdf") => "application/pdf",
        _ => "application/octet-stream",
    }
}

fn is_text(media: &str) -> bool {
    media.starts_with("text/") || media == "application/json"
}

/// Descriptor for an artifact in a tool result (RFC 0009 section 1.4).
pub fn descriptor(path: &str, t: &str, uri: &str) -> Value {
    let mut d = json!({ "uri": uri, "type": t, "path": path, "mediaType": media_type(path) });
    if let Ok(meta) = fs::metadata(path) {
        if meta.is_file() {
            d["bytes"] = json!(meta.len());
        }
    }
    d
}

enum Target {
    Artifact { run: String, step: String, output: String, index: Option<usize>, raw: bool },
    Provenance(String),
    Record(String),
    Log { run: String, step: String, stream: String },
    Catalog { id: String },
    Schema(String),
}

fn parse(uri: &str) -> Result<Target, String> {
    let rest = uri.strip_prefix("neuroflow://").ok_or("not a neuroflow:// URI")?;
    let parts: Vec<&str> = rest.split('/').collect();
    let bad = || format!("unrecognized neuroflow URI {uri}");
    match parts.as_slice() {
        ["runs", run, "provenance"] => Ok(Target::Provenance(run.to_string())),
        ["runs", run, "record"] => Ok(Target::Record(run.to_string())),
        ["runs", run, "logs", step, stream] if matches!(*stream, "stdout" | "stderr") => Ok(Target::Log {
            run: run.to_string(),
            step: step.to_string(),
            stream: stream.to_string(),
        }),
        ["runs", run, "artifacts", step, output, tail @ ..] => {
            let (index, raw) = match tail {
                [] => (None, false),
                ["raw"] => (None, true),
                [i] => (Some(i.parse().map_err(|_| bad())?), false),
                [i, "raw"] => (Some(i.parse().map_err(|_| bad())?), true),
                _ => return Err(bad()),
            };
            Ok(Target::Artifact { run: run.to_string(), step: step.to_string(), output: output.to_string(), index, raw })
        }
        ["catalog", "tools" | "workflows", id] => Ok(Target::Catalog { id: pct_decode(id) }),
        ["schemas", ..] => Ok(Target::Schema(parts[1..].join("/"))),
        _ => Err(bad()),
    }
}

fn safe_segment(s: &str) -> Result<&str, String> {
    if s.is_empty() || s.contains("..") || s.contains('\\') || s.starts_with('.') {
        Err(format!("invalid path segment {s:?}"))
    } else {
        Ok(s)
    }
}

fn run_dir(cfg: &Config, run: &str) -> Result<PathBuf, String> {
    let dir = cfg.sessions_root.join(safe_segment(run)?);
    if dir.join("run.json").is_file() {
        Ok(dir)
    } else {
        Err(format!("unknown run {run}"))
    }
}

fn load_record(cfg: &Config, run: &str) -> Result<Value, String> {
    let text = fs::read_to_string(run_dir(cfg, run)?.join("run.json")).map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

/// (path, NeuroFlow type) of an artifact URI.
fn artifact_path(cfg: &Config, run: &str, step: &str, output: &str, index: Option<usize>) -> Result<(String, String), String> {
    let record = load_record(cfg, run)?;
    let value = record
        .pointer(&format!("/steps/{step}/outputs/{output}"))
        .ok_or_else(|| format!("run {run} has no output {step}.{output}"))?;
    let t = record
        .pointer(&format!("/steps/{step}/types/{output}"))
        .and_then(Value::as_str)
        .unwrap_or("core:file");
    let element = neuroflow_core::array_element_type(t).unwrap_or(t).to_string();
    let path = match (value, index) {
        (Value::Array(items), Some(i)) => items.get(i).and_then(Value::as_str).ok_or_else(|| format!("index {i} out of range"))?,
        (Value::String(p), None | Some(0)) => p.as_str(),
        (Value::Array(_), None) => return Err("this output is a list; add /<index> to the URI".into()),
        _ => return Err(format!("{step}.{output} is a value, not an artifact")),
    };
    Ok((path.to_string(), element))
}

pub fn resolve_artifact_uri(cfg: &Config, uri: &str) -> Result<PathBuf, String> {
    match parse(uri)? {
        Target::Artifact { run, step, output, index, raw: false } => {
            artifact_path(cfg, &run, &step, &output, index).map(|(p, _)| PathBuf::from(p))
        }
        _ => Err(format!("{uri} is not an artifact URI")),
    }
}

/// `resources/read` contents for a `neuroflow://` URI.
pub fn read(cfg: &Config, registry: &Registry, uri: &str) -> Result<Vec<Value>, String> {
    let text = |mime: &str, body: String| vec![json!({ "uri": uri, "mimeType": mime, "text": body })];
    let pretty = |v: &Value| serde_json::to_string_pretty(v).unwrap_or_default();
    match parse(uri)? {
        Target::Provenance(run) => {
            let body = fs::read_to_string(run_dir(cfg, &run)?.join("run.provenance.json")).map_err(|e| e.to_string())?;
            Ok(text("application/json", body))
        }
        Target::Record(run) => Ok(text("application/json", pretty(&load_record(cfg, &run)?))),
        Target::Log { run, step, stream } => {
            let path = run_dir(cfg, &run)?.join("logs").join(format!("{}.{stream}", safe_segment(&step)?));
            let body = fs::read_to_string(&path).map_err(|_| format!("no {stream} log for step {step}"))?;
            Ok(text("text/plain", tail(&body, 64 * 1024)))
        }
        Target::Catalog { id } => {
            let doc = registry.get(&id).ok_or_else(|| format!("unknown document {id}"))?;
            Ok(text("application/json", pretty(&doc.value)))
        }
        Target::Schema(rel) => {
            let spec = cfg.spec_dir.as_ref().ok_or("server was started without --spec")?;
            for seg in rel.split('/') {
                safe_segment(seg)?;
            }
            let body = fs::read_to_string(spec.join("schemas").join(&rel)).map_err(|_| format!("unknown schema {rel}"))?;
            Ok(text("application/schema+json", body))
        }
        Target::Artifact { run, step, output, index, raw } => {
            let (path, t) = artifact_path(cfg, &run, &step, &output, index)?;
            if raw {
                return read_raw(uri, &path);
            }
            let mut s = summarize(&path, &t, cfg.summary_max_bytes);
            s["uri"] = json!(uri);
            Ok(vec![json!({ "uri": uri, "mimeType": "application/vnd.neuroflow.artifact-summary+json", "text": pretty(&s) })])
        }
    }
}

fn read_raw(uri: &str, path: &str) -> Result<Vec<Value>, String> {
    let media = media_type(path);
    let meta = fs::metadata(path).map_err(|e| e.to_string())?;
    if meta.is_dir() {
        return Err("raw reads are not available for directories; read the summary URI instead".into());
    }
    let limit = if is_text(media) { RAW_TEXT_MAX } else { RAW_BINARY_MAX };
    if meta.len() > limit {
        return Err(format!(
            "{} bytes exceeds the raw read limit of {limit} bytes; read the summary URI (without /raw) instead",
            meta.len()
        ));
    }
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    if is_text(media) {
        Ok(vec![json!({ "uri": uri, "mimeType": media, "text": String::from_utf8_lossy(&bytes) })])
    } else {
        Ok(vec![json!({ "uri": uri, "mimeType": media, "blob": base64(&bytes) })])
    }
}

fn tail(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut start = s.len() - max;
    while !s.is_char_boundary(start) {
        start += 1;
    }
    format!("[... truncated ...]\n{}", &s[start..])
}

/// Artifact summary (RFC 0009 section 5.2).
pub fn summarize(path: &str, t: &str, max_bytes: u64) -> Value {
    let p = Path::new(path);
    let mut out = json!({ "type": t, "path": path, "mediaType": media_type(path) });
    let Ok(meta) = fs::metadata(p) else {
        out["exists"] = json!(false);
        return out;
    };
    out["exists"] = json!(true);
    if meta.is_dir() {
        out["summary"] = summarize_dir(p);
        return out;
    }
    out["bytes"] = json!(meta.len());
    let lower = path.to_ascii_lowercase();
    let summary = if lower.ends_with(".nii") || lower.ends_with(".nii.gz") {
        match nifti_summary(p, t, max_bytes) {
            Ok(s) => s,
            Err(e) => json!({ "error": e }),
        }
    } else if lower.ends_with(".json") && meta.len() <= 256 * 1024 {
        fs::read_to_string(p)
            .ok()
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .map(|v| json!({ "content": v }))
            .unwrap_or(json!({ "error": "not valid JSON" }))
    } else if lower.ends_with(".tsv") || lower.ends_with(".csv") {
        table_summary(p, if lower.ends_with(".csv") { ',' } else { '\t' })
    } else if lower.ends_with(".html") || lower.ends_with(".htm") {
        let head = read_prefix(p, 64 * 1024);
        let title = head
            .split("<title>")
            .nth(1)
            .and_then(|s| s.split("</title>").next())
            .map(str::trim)
            .unwrap_or("");
        json!({ "title": title })
    } else {
        json!({})
    };
    out["summary"] = summary;
    out
}

fn read_prefix(p: &Path, n: usize) -> String {
    let mut buf = Vec::new();
    if let Ok(f) = fs::File::open(p) {
        let _ = f.take(n as u64).read_to_end(&mut buf);
    }
    String::from_utf8_lossy(&buf).into_owned()
}

fn table_summary(p: &Path, sep: char) -> Value {
    let Ok(text) = fs::read_to_string(p) else { return json!({ "error": "unreadable" }) };
    let mut lines = text.lines().filter(|l| !l.trim().is_empty());
    let columns: Vec<&str> = lines.next().map(|h| h.split(sep).collect()).unwrap_or_default();
    let rows: Vec<Vec<&str>> = lines.map(|l| l.split(sep).collect()).collect();
    json!({
        "columns": columns,
        "rowCount": rows.len(),
        "firstRows": rows.iter().take(5).collect::<Vec<_>>(),
    })
}

fn summarize_dir(p: &Path) -> Value {
    let mut entries: Vec<String> = fs::read_dir(p)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            if e.path().is_dir() { format!("{name}/") } else { name }
        })
        .filter(|n| !n.starts_with('.'))
        .collect();
    entries.sort();
    let mut files = 0usize;
    let mut bytes = 0u64;
    let mut ext_counts: BTreeMap<String, usize> = BTreeMap::new();
    walk(p, 0, &mut |path| {
        files += 1;
        bytes += fs::metadata(path).map(|m| m.len()).unwrap_or(0);
        let name = path.file_name().map(|n| n.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
        let ext = if name.ends_with(".nii.gz") {
            ".nii.gz".to_string()
        } else {
            path.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_else(|| "(none)".into())
        };
        *ext_counts.entry(ext).or_default() += 1;
    });
    let mut s = json!({
        "entries": entries.iter().take(50).collect::<Vec<_>>(),
        "entryCount": entries.len(),
        "fileCount": files,
        "totalBytes": bytes,
        "fileTypes": ext_counts,
    });
    let description = p.join("dataset_description.json");
    if description.is_file() {
        let mut bids = json!({});
        if let Ok(v) = fs::read_to_string(&description).map(|t| serde_json::from_str::<Value>(&t)) {
            if let Ok(v) = v {
                bids["datasetDescription"] = v;
            }
        }
        let subjects: Vec<&String> = entries.iter().filter(|e| e.starts_with("sub-")).collect();
        let mut sessions = 0;
        let mut datatypes: BTreeMap<String, usize> = BTreeMap::new();
        for sub in &subjects {
            let sub_dir = p.join(sub.trim_end_matches('/'));
            for entry in fs::read_dir(&sub_dir).into_iter().flatten().flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if name.starts_with("ses-") {
                    sessions += 1;
                    for dt in fs::read_dir(entry.path()).into_iter().flatten().flatten() {
                        if dt.path().is_dir() {
                            *datatypes.entry(dt.file_name().to_string_lossy().into_owned()).or_default() += 1;
                        }
                    }
                } else if entry.path().is_dir() {
                    *datatypes.entry(name).or_default() += 1;
                }
            }
        }
        bids["subjects"] = json!(subjects.iter().map(|s| s.trim_end_matches('/')).collect::<Vec<_>>());
        bids["sessionCount"] = json!(sessions);
        bids["datatypes"] = json!(datatypes);
        s["bids"] = bids;
    }
    s
}

fn walk(dir: &Path, depth: usize, f: &mut dyn FnMut(&Path)) {
    if depth > 12 {
        return;
    }
    for entry in fs::read_dir(dir).into_iter().flatten().flatten() {
        let path = entry.path();
        if entry.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        if path.is_dir() {
            walk(&path, depth + 1, f);
        } else {
            f(&path);
        }
    }
}

// ---------------------------------------------------------------------------
// NIfTI header and intensity summary

struct Reader<'a> {
    b: &'a [u8],
    le: bool,
}

impl Reader<'_> {
    fn i16(&self, o: usize) -> i16 {
        let a = [self.b[o], self.b[o + 1]];
        if self.le { i16::from_le_bytes(a) } else { i16::from_be_bytes(a) }
    }
    fn i32(&self, o: usize) -> i32 {
        let a: [u8; 4] = self.b[o..o + 4].try_into().unwrap();
        if self.le { i32::from_le_bytes(a) } else { i32::from_be_bytes(a) }
    }
    fn i64(&self, o: usize) -> i64 {
        let a: [u8; 8] = self.b[o..o + 8].try_into().unwrap();
        if self.le { i64::from_le_bytes(a) } else { i64::from_be_bytes(a) }
    }
    fn f32(&self, o: usize) -> f64 {
        let a: [u8; 4] = self.b[o..o + 4].try_into().unwrap();
        f64::from(if self.le { f32::from_le_bytes(a) } else { f32::from_be_bytes(a) })
    }
    fn f64(&self, o: usize) -> f64 {
        let a: [u8; 8] = self.b[o..o + 8].try_into().unwrap();
        if self.le { f64::from_le_bytes(a) } else { f64::from_be_bytes(a) }
    }
}

struct Header {
    version: u8,
    dims: Vec<i64>,
    datatype: i16,
    pixdim: Vec<f64>,
    vox_offset: u64,
    slope: f64,
    inter: f64,
    xyzt_units: u8,
    qform_code: i32,
    sform_code: i32,
    /// Voxel-to-world 3x4 matrix from sform or qform, when available.
    affine: Option<[[f64; 4]; 3]>,
    descrip: String,
    le: bool,
}

fn open_nifti(p: &Path) -> Result<Box<dyn Read>, String> {
    let f = fs::File::open(p).map_err(|e| e.to_string())?;
    if p.to_string_lossy().to_ascii_lowercase().ends_with(".gz") {
        Ok(Box::new(GzDecoder::new(f)))
    } else {
        Ok(Box::new(f))
    }
}

fn parse_header(b: &[u8]) -> Result<Header, String> {
    if b.len() < 348 {
        return Err("file is too small to be NIfTI".into());
    }
    let le_size = i32::from_le_bytes(b[0..4].try_into().unwrap());
    let be_size = i32::from_be_bytes(b[0..4].try_into().unwrap());
    let (version, le) = match (le_size, be_size) {
        (348, _) => (1, true),
        (_, 348) => (1, false),
        (540, _) => (2, true),
        (_, 540) => (2, false),
        _ => return Err("not a NIfTI-1 or NIfTI-2 header".into()),
    };
    let r = Reader { b, le };
    if version == 1 {
        let ndim = r.i16(40).clamp(0, 7) as usize;
        let dims = (1..=ndim).map(|i| i64::from(r.i16(40 + 2 * i))).collect();
        let pixdim: Vec<f64> = (0..8).map(|i| r.f32(76 + 4 * i)).collect();
        let qform_code = i32::from(r.i16(252));
        let sform_code = i32::from(r.i16(254));
        let affine = if sform_code > 0 {
            Some([
                [r.f32(280), r.f32(284), r.f32(288), r.f32(292)],
                [r.f32(296), r.f32(300), r.f32(304), r.f32(308)],
                [r.f32(312), r.f32(316), r.f32(320), r.f32(324)],
            ])
        } else if qform_code > 0 {
            Some(qform_affine(r.f32(256), r.f32(260), r.f32(264), [r.f32(268), r.f32(272), r.f32(276)], &pixdim))
        } else {
            None
        };
        let descrip = String::from_utf8_lossy(&b[148..228]).trim_end_matches('\0').trim().to_string();
        Ok(Header {
            version,
            dims,
            datatype: r.i16(70),
            vox_offset: r.f32(108).max(352.0) as u64,
            slope: r.f32(112),
            inter: r.f32(116),
            xyzt_units: b[123],
            qform_code,
            sform_code,
            affine,
            descrip,
            pixdim,
            le,
        })
    } else {
        if b.len() < 540 {
            return Err("truncated NIfTI-2 header".into());
        }
        let ndim = r.i64(16).clamp(0, 7) as usize;
        let dims = (1..=ndim).map(|i| r.i64(16 + 8 * i)).collect();
        let pixdim: Vec<f64> = (0..8).map(|i| r.f64(104 + 8 * i)).collect();
        let qform_code = r.i32(344);
        let sform_code = r.i32(348);
        let affine = if sform_code > 0 {
            Some([
                [r.f64(400), r.f64(408), r.f64(416), r.f64(424)],
                [r.f64(432), r.f64(440), r.f64(448), r.f64(456)],
                [r.f64(464), r.f64(472), r.f64(480), r.f64(488)],
            ])
        } else if qform_code > 0 {
            Some(qform_affine(r.f64(352), r.f64(360), r.f64(368), [r.f64(376), r.f64(384), r.f64(392)], &pixdim))
        } else {
            None
        };
        let descrip = String::from_utf8_lossy(&b[240..320]).trim_end_matches('\0').trim().to_string();
        Ok(Header {
            version,
            dims,
            datatype: r.i16(12),
            vox_offset: r.i64(168).max(544) as u64,
            slope: r.f64(176),
            inter: r.f64(184),
            xyzt_units: b[500],
            qform_code,
            sform_code,
            affine,
            descrip,
            pixdim,
            le,
        })
    }
}

fn qform_affine(b: f64, c: f64, d: f64, offset: [f64; 3], pixdim: &[f64]) -> [[f64; 4]; 3] {
    let a = (1.0 - (b * b + c * c + d * d)).max(0.0).sqrt();
    let qfac = if pixdim[0] < 0.0 { -1.0 } else { 1.0 };
    let (dx, dy, dz) = (pixdim[1], pixdim[2], pixdim[3] * qfac);
    let rot = [
        [a * a + b * b - c * c - d * d, 2.0 * (b * c - a * d), 2.0 * (b * d + a * c)],
        [2.0 * (b * c + a * d), a * a + c * c - b * b - d * d, 2.0 * (c * d - a * b)],
        [2.0 * (b * d - a * c), 2.0 * (c * d + a * b), a * a + d * d - c * c - b * b],
    ];
    let mut m = [[0.0; 4]; 3];
    for i in 0..3 {
        m[i] = [rot[i][0] * dx, rot[i][1] * dy, rot[i][2] * dz, offset[i]];
    }
    m
}

/// Axis codes like "RAS": the world direction each voxel axis increases toward.
fn axcodes(m: &[[f64; 4]; 3]) -> String {
    let mut used = [false; 3];
    let mut out = String::new();
    for col in 0..3 {
        let v = [m[0][col], m[1][col], m[2][col]];
        let mut best = None;
        for row in 0..3 {
            if used[row] {
                continue;
            }
            if best.is_none_or(|b: usize| v[row].abs() > v[b].abs()) {
                best = Some(row);
            }
        }
        let Some(row) = best else { return "?".into() };
        used[row] = true;
        let pos = v[row] >= 0.0;
        out.push(match (row, pos) {
            (0, true) => 'R',
            (0, false) => 'L',
            (1, true) => 'A',
            (1, false) => 'P',
            (2, true) => 'S',
            _ => 'I',
        });
    }
    out
}

fn datatype_info(code: i16) -> Option<(&'static str, usize)> {
    Some(match code {
        2 => ("uint8", 1),
        4 => ("int16", 2),
        8 => ("int32", 4),
        16 => ("float32", 4),
        64 => ("float64", 8),
        256 => ("int8", 1),
        512 => ("uint16", 2),
        768 => ("uint32", 4),
        1024 => ("int64", 8),
        1280 => ("uint64", 8),
        _ => return None,
    })
}

fn nifti_summary(p: &Path, t: &str, max_bytes: u64) -> Result<Value, String> {
    let mut reader = open_nifti(p)?;
    let mut head = vec![0u8; 540];
    let mut got = 0;
    while got < head.len() {
        let n = reader.read(&mut head[got..]).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        got += n;
    }
    head.truncate(got);
    let h = parse_header(&head)?;

    let spatial_scale = match h.xyzt_units & 0x07 {
        1 => 1000.0, // meters
        3 => 0.001,  // micrometers
        _ => 1.0,    // millimeters or unknown
    };
    let voxel_mm = [h.pixdim[1], h.pixdim[2], h.pixdim[3]].map(|v| (v * spatial_scale).abs());
    let voxel_ml = voxel_mm.iter().product::<f64>() / 1000.0;
    let (dtype, bytes_per) = datatype_info(h.datatype).unwrap_or(("unsupported", 0));
    let mut s = json!({
        "format": if h.version == 1 { "NIfTI-1" } else { "NIfTI-2" },
        "dims": h.dims,
        "voxelSizeMm": voxel_mm,
        "voxelVolumeMl": round(voxel_ml, 6),
        "datatype": dtype,
        "qformCode": h.qform_code,
        "sformCode": h.sform_code,
    });
    if let Some(m) = &h.affine {
        s["orientation"] = json!(axcodes(m));
    }
    if !h.descrip.is_empty() {
        s["description"] = json!(h.descrip);
    }

    let n_vox: i64 = h.dims.iter().map(|d| (*d).max(1)).product();
    let data_bytes = (n_vox as u64).saturating_mul(bytes_per as u64);
    if bytes_per == 0 {
        s["intensity"] = json!({ "skipped": format!("datatype {} not summarized", h.datatype) });
        return Ok(s);
    }
    if data_bytes > max_bytes {
        s["intensity"] = json!({ "skipped": format!("{data_bytes} bytes of voxel data exceeds the summary limit") });
        return Ok(s);
    }
    // Skip to vox_offset, then read the data block.
    let mut rest = Vec::new();
    reader.read_to_end(&mut rest).map_err(|e| e.to_string())?;
    let mut all = head;
    all.extend_from_slice(&rest);
    let start = h.vox_offset as usize;
    let end = start + data_bytes as usize;
    if all.len() < end {
        s["intensity"] = json!({ "skipped": "voxel data is truncated" });
        return Ok(s);
    }
    let data = &all[start..end];
    let r = Reader { b: data, le: h.le };
    let scale = h.slope != 0.0 && !(h.slope == 1.0 && h.inter == 0.0);
    let value_at = |i: usize| -> f64 {
        let o = i * bytes_per;
        let raw = match h.datatype {
            2 => f64::from(data[o]),
            256 => f64::from(data[o] as i8),
            4 => f64::from(r.i16(o)),
            512 => f64::from(r.i16(o) as u16),
            8 => f64::from(r.i32(o)),
            768 => f64::from(r.i32(o) as u32),
            16 => r.f32(o),
            64 => r.f64(o),
            1024 => r.i64(o) as f64,
            1280 => r.i64(o) as u64 as f64,
            _ => f64::NAN,
        };
        if scale { raw * h.slope + h.inter } else { raw }
    };
    let (mut min, mut max, mut sum, mut nonzero, mut finite) = (f64::INFINITY, f64::NEG_INFINITY, 0.0, 0u64, 0u64);
    let label_like = matches!(t, "neuro:label-map" | "neuro:mask");
    let mut labels: BTreeMap<i64, u64> = BTreeMap::new();
    let mut too_many_labels = false;
    for i in 0..n_vox as usize {
        let v = value_at(i);
        if !v.is_finite() {
            continue;
        }
        finite += 1;
        min = min.min(v);
        max = max.max(v);
        sum += v;
        if v != 0.0 {
            nonzero += 1;
        }
        if label_like && !too_many_labels && v.fract() == 0.0 {
            *labels.entry(v as i64).or_default() += 1;
            if labels.len() > 1000 {
                too_many_labels = true;
            }
        }
    }
    if finite > 0 {
        s["intensity"] = json!({
            "min": round(min, 6), "max": round(max, 6), "mean": round(sum / finite as f64, 6),
            "nonzeroVoxels": nonzero,
            "nonzeroVolumeMl": round(nonzero as f64 * voxel_ml, 3),
        });
    }
    if label_like && !too_many_labels {
        let table: Map<String, Value> = labels
            .iter()
            .filter(|(k, _)| **k != 0)
            .map(|(k, n)| (k.to_string(), json!({ "voxels": n, "volumeMl": round(*n as f64 * voxel_ml, 3) })))
            .collect();
        s["labels"] = Value::Object(table);
    }
    Ok(s)
}

fn round(v: f64, places: i32) -> f64 {
    let f = 10f64.powi(places);
    (v * f).round() / f
}

/// Resources for `resources/list`.
pub fn list(cfg: &Config, registry: &Registry) -> Vec<Value> {
    let mut out = Vec::new();
    if let Some(spec) = &cfg.spec_dir {
        let root = spec.join("schemas");
        let mut files = Vec::new();
        walk(&root, 0, &mut |p| {
            if p.to_string_lossy().ends_with(".schema.json") {
                files.push(p.to_path_buf());
            }
        });
        files.sort();
        for f in files {
            if let Ok(rel) = f.strip_prefix(&root) {
                let rel = rel.to_string_lossy().replace('\\', "/");
                out.push(json!({ "uri": format!("neuroflow://schemas/{rel}"), "name": rel,
                    "mimeType": "application/schema+json", "description": "NeuroFlow JSON Schema" }));
            }
        }
    }
    for doc in &registry.docs {
        let kind = if doc.kind == crate::registry::Kind::Tool { "tools" } else { "workflows" };
        out.push(json!({ "uri": format!("neuroflow://catalog/{kind}/{}", pct_encode(&doc.id)),
            "name": doc.id, "title": doc.title, "mimeType": "application/json",
            "description": format!("NeuroFlow {} document", doc.kind.as_str()) }));
    }
    // Recent runs.
    let mut runs: Vec<(std::time::SystemTime, String)> = fs::read_dir(&cfg.sessions_root)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.path().join("run.provenance.json").is_file())
        .map(|e| (e.metadata().and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH), e.file_name().to_string_lossy().into_owned()))
        .collect();
    runs.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, run) in runs.into_iter().take(20) {
        out.push(json!({ "uri": format!("neuroflow://runs/{run}/provenance"), "name": format!("{run} provenance"),
            "mimeType": "application/json" }));
    }
    out
}

pub fn templates() -> Vec<Value> {
    vec![
        json!({ "uriTemplate": "neuroflow://runs/{runId}/artifacts/{step}/{output}{/index}",
            "name": "artifact-summary", "mimeType": "application/vnd.neuroflow.artifact-summary+json",
            "description": "Summary of a run artifact: NIfTI dimensions, voxel size, orientation, intensity range, label volumes; dataset layout for directories." }),
        json!({ "uriTemplate": "neuroflow://runs/{runId}/artifacts/{step}/{output}{/index}/raw",
            "name": "artifact-raw", "description": "Raw bytes of a small artifact (text up to 4 MiB, binary up to 1 MiB)." }),
        json!({ "uriTemplate": "neuroflow://runs/{runId}/provenance", "name": "run-provenance", "mimeType": "application/json" }),
        json!({ "uriTemplate": "neuroflow://runs/{runId}/logs/{step}/{stream}", "name": "step-log", "mimeType": "text/plain",
            "description": "stdout or stderr of a step." }),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn axcodes_for_ras_and_las() {
        let ras = [[1.0, 0.0, 0.0, 0.0], [0.0, 1.0, 0.0, 0.0], [0.0, 0.0, 1.0, 0.0]];
        assert_eq!(axcodes(&ras), "RAS");
        let las = [[-1.0, 0.0, 0.0, 0.0], [0.0, 1.0, 0.0, 0.0], [0.0, 0.0, 1.0, 0.0]];
        assert_eq!(axcodes(&las), "LAS");
    }

    /// Minimal little-endian NIfTI-1 (.nii) with int16 data and an sform.
    fn write_nifti(path: &Path, dims: [i16; 3], voxel: f32, data: &[i16]) {
        let mut h = vec![0u8; 352];
        h[0..4].copy_from_slice(&348i32.to_le_bytes());
        let dim = [3i16, dims[0], dims[1], dims[2], 1, 1, 1, 1];
        for (i, d) in dim.iter().enumerate() {
            h[40 + 2 * i..42 + 2 * i].copy_from_slice(&d.to_le_bytes());
        }
        h[70..72].copy_from_slice(&4i16.to_le_bytes()); // int16
        h[72..74].copy_from_slice(&16i16.to_le_bytes());
        let pixdim = [1.0f32, voxel, voxel, voxel, 1.0, 1.0, 1.0, 1.0];
        for (i, v) in pixdim.iter().enumerate() {
            h[76 + 4 * i..80 + 4 * i].copy_from_slice(&v.to_le_bytes());
        }
        h[108..112].copy_from_slice(&352f32.to_le_bytes());
        h[123] = 2; // mm
        h[254..256].copy_from_slice(&1i16.to_le_bytes()); // sform_code
        // sform: LAS (x flipped)
        for (o, v) in [(280, -voxel), (300, voxel), (320, voxel)] {
            h[o..o + 4].copy_from_slice(&v.to_le_bytes());
        }
        h[344..348].copy_from_slice(b"n+1\0");
        for v in data {
            h.extend_from_slice(&v.to_le_bytes());
        }
        fs::write(path, h).unwrap();
    }

    #[test]
    fn summarizes_label_map_volumes() {
        let dir = std::env::temp_dir().join(format!("nf-mcp-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("labels.nii");
        // 4x4x4 at 2 mm: label 17 on 8 voxels, label 53 on 2 voxels.
        let mut data = vec![0i16; 64];
        for v in data.iter_mut().take(8) {
            *v = 17;
        }
        data[20] = 53;
        data[21] = 53;
        write_nifti(&path, [4, 4, 4], 2.0, &data);
        let s = summarize(path.to_str().unwrap(), "neuro:label-map", 1 << 20);
        let summary = &s["summary"];
        assert_eq!(summary["dims"], json!([4, 4, 4]));
        assert_eq!(summary["orientation"], "LAS");
        assert_eq!(summary["labels"]["17"]["voxels"], 8);
        assert_eq!(summary["labels"]["17"]["volumeMl"], 0.064); // 8 * 8 mm^3
        assert_eq!(summary["labels"]["53"]["volumeMl"], 0.016);
        assert_eq!(summary["intensity"]["nonzeroVoxels"], 10);
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn parses_artifact_uris() {
        assert!(matches!(
            parse("neuroflow://runs/r1/artifacts/filter/filtered_volumes/2").unwrap(),
            Target::Artifact { index: Some(2), raw: false, .. }
        ));
        assert!(matches!(
            parse("neuroflow://runs/r1/artifacts/qa/qa_html/raw").unwrap(),
            Target::Artifact { index: None, raw: true, .. }
        ));
        assert!(matches!(parse("neuroflow://runs/../provenance").unwrap(), Target::Provenance(ref r) if r == ".."));
        assert!(safe_segment("..").is_err());
    }
}
