// OMP Rust prelude — injected before user code in each eval cell.
//
// Single-shot model: each cell is a standalone Rust program compiled and run
// via `rustc`. State does NOT persist across cells — every cell starts fresh.
// The prelude provides helpers (display, read, write, env) that mirror the
// cross-runtime surface available in the py/rb/jl backends.
//
// Tool bridge (completion/agent/parallel) is NOT wired for the single-shot
// backend. Use the py/js/rb/jl backends when you need agent() or completion().
//
// This module is std-only — no external crates. Each cell is compiled with
// `rustc` directly (no Cargo).

use std::collections::HashMap;
use std::env as std_env;
use std::fmt::Display;
use std::fs;
use std::io::{self, Write};
use std::path::PathBuf;

// ---------------------------------------------------------------------------
// Internal-URL path resolution
// ---------------------------------------------------------------------------

/// Map a `scheme://path` helper URL to a real filesystem path using the
/// PI_EVAL_LOCAL_ROOTS JSON map (e.g. `local://` → artifacts dir).
fn omp_resolve_path(raw: &str) -> Result<PathBuf, String> {
    if let Some(rest) = raw.strip_prefix("local://") {
        let roots_json = std_env::var("PI_EVAL_LOCAL_ROOTS").unwrap_or_default();
        if roots_json.is_empty() {
            return Err(format!(
                "local:// not available (PI_EVAL_LOCAL_ROOTS unset): {raw}"
            ));
        }
        let roots: HashMap<String, String> = omp_parse_simple_json_obj(&roots_json)
            .map_err(|e| format!("bad PI_EVAL_LOCAL_ROOTS: {e}"))?;
        let root = roots
            .get("local")
            .ok_or_else(|| format!("local:// root not configured: {raw}"))?;
        let root = PathBuf::from(root)
            .canonicalize()
            .map_err(|e| format!("local root not found ({root}): {e}"))?;
        let relative = rest.trim_start_matches('/');
        if relative.is_empty() {
            return Ok(root);
        }
        if relative.contains("..") || relative.starts_with('/') {
            return Err(format!("unsafe local:// path (traversal): {raw}"));
        }
        let resolved = root.join(relative);
        let resolved = resolved
            .canonicalize()
            .map_err(|e| format!("path not found: {resolved:?}: {e}"))?;
        if !resolved.starts_with(&root) {
            return Err(format!("local:// path escapes root: {raw}"));
        }
        Ok(resolved)
    } else {
        Ok(PathBuf::from(raw))
    }
}

// ---------------------------------------------------------------------------
// Minimal JSON helpers (std-only — no serde)
// ---------------------------------------------------------------------------

/// Parse a flat JSON object like `{"key":"val","k2":"v2"}` into a HashMap.
/// Deliberately minimal: only string values, no nesting, no arrays.
fn omp_parse_simple_json_obj(s: &str) -> Result<HashMap<String, String>, String> {
    let s = s.trim();
    let inner = s
        .strip_prefix('{')
        .and_then(|t| t.strip_suffix('}'))
        .ok_or_else(|| "not a JSON object".to_string())?;
    let mut map = HashMap::new();
    if inner.trim().is_empty() {
        return Ok(map);
    }
    for pair in split_json_pairs(inner) {
        let (raw_key, raw_val) = split_json_pair(&pair)?;
        let key = unquote_json_str(raw_key)?;
        let val = unquote_json_str(raw_val)?;
        map.insert(key, val);
    }
    Ok(map)
}

fn split_json_pairs(s: &str) -> Vec<String> {
    let mut pairs = Vec::new();
    let mut depth = 0i32;
    let mut in_string = false;
    let mut escaped = false;
    let mut start = 0usize;
    for (i, ch) in s.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        match ch {
            '\\' if in_string => escaped = true,
            '"' => in_string = !in_string,
            '{' | '[' if !in_string => depth += 1,
            '}' | ']' if !in_string => depth -= 1,
            ',' if !in_string && depth == 0 => {
                pairs.push(s[start..i].trim().to_string());
                start = i + 1;
            }
            _ => {}
        }
    }
    let last = s[start..].trim().to_string();
    if !last.is_empty() {
        pairs.push(last);
    }
    pairs
}

fn split_json_pair(pair: &str) -> Result<(&str, &str), String> {
    let colon = pair
        .find(':')
        .ok_or_else(|| format!("missing colon in JSON pair: {pair}"))?;
    Ok((pair[..colon].trim(), pair[colon + 1..].trim()))
}

fn unquote_json_str(s: &str) -> Result<String, String> {
    let s = s.trim();
    let inner = s
        .strip_prefix('"')
        .and_then(|t| t.strip_suffix('"'))
        .ok_or_else(|| format!("not a JSON string: {s}"))?;
    let mut out = String::with_capacity(inner.len());
    let mut chars = inner.chars();
    while let Some(ch) = chars.next() {
        if ch == '\\' {
            match chars.next() {
                Some('"') => out.push('"'),
                Some('\\') => out.push('\\'),
                Some('/') => out.push('/'),
                Some('n') => out.push('\n'),
                Some('t') => out.push('\t'),
                Some('r') => out.push('\r'),
                Some('u') => {
                    let mut hex = String::with_capacity(4);
                    for _ in 0..4 {
                        hex.push(chars.next().unwrap_or('0'));
                    }
                    let cp = u32::from_str_radix(&hex, 16).unwrap_or(0xFFFD);
                    if let Some(c) = char::from_u32(cp) {
                        out.push(c);
                    }
                }
                Some(other) => {
                    out.push('\\');
                    out.push(other);
                }
                None => break,
            }
        } else {
            out.push(ch);
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Display — print values to stdout (captured by harness)
// ---------------------------------------------------------------------------

/// Print a Display-able value. The harness captures stdout as cell output.
pub fn display(val: &dyn Display) {
    println!("{val}");
}

/// Print a Debug-able value with {:?} formatting.
pub fn display_debug(val: &dyn std::fmt::Debug) {
    println!("{val:?}");
}

/// Print a pretty-printed Debug value.
pub fn display_pretty(val: &dyn std::fmt::Debug) {
    println!("{val:#?}");
}

// ---------------------------------------------------------------------------
// File I/O helpers
// ---------------------------------------------------------------------------

/// Read a file (or local:// URL) and return its contents as a String.
pub fn read(path: &str) -> Result<String, String> {
    let resolved = omp_resolve_path(path)?;
    fs::read_to_string(&resolved).map_err(|e| format!("read({path}): {e}"))
}

/// Write content to a file (or local:// URL). Creates parent directories.
/// Returns the resolved path.
pub fn write(path: &str, content: &str) -> Result<String, String> {
    let resolved = omp_resolve_path(path)?;
    if let Some(parent) = resolved.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("write({path}): {e}"))?;
    }
    fs::write(&resolved, content).map_err(|e| format!("write({path}): {e}"))?;
    Ok(resolved.to_string_lossy().to_string())
}

// ---------------------------------------------------------------------------
// Environment access
// ---------------------------------------------------------------------------

/// Get an environment variable by name, or return all vars if `key` is None.
pub fn env(key: Option<&str>) -> String {
    match key {
        Some(k) => std_env::var(k).unwrap_or_else(|_| format!("<unset: {k}>")),
        None => {
            let mut vars: Vec<(String, String)> = std_env::vars().collect();
            vars.sort_by(|a, b| a.0.cmp(&b.0));
            let max_width = vars.iter().map(|(k, _)| k.len()).max().unwrap_or(0);
            vars.iter()
                .map(|(k, v)| format!("{k:>max_width$} = {v}"))
                .collect::<Vec<_>>()
                .join("\n")
        }
    }
}
