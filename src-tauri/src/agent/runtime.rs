//! Bridge runtime extraction — see docs/adr/002-bridge-runtime-tarball.md.
//!
//! Production bundles ship the Claude Agent SDK's `node_modules` (SDK +
//! zod + transitive deps + the ~230 MB platform-native `claude` binary the
//! SDK shells out to) as a single compressed `bridge-runtime.tar.zst` Tauri
//! resource instead of ~6k raw files. Raw files made every install ~210 MB
//! heavier and broke `linuxdeploy`'s AppImage packaging (v1.1.3).
//!
//! This module extracts that tarball once per SDK version into the app's
//! local-data dir (never the roaming profile — see [`ensure_runtime_extracted`])
//! and hands back the directory the bridge should resolve its npm deps
//! from. Dev builds never reach this: `resolve_bridge_runtime_dir` in
//! `agent::mod` prefers an adjacent `node_modules` (staged directly by
//! `scripts/stage-bridge-deps.mjs`) when one exists, which is always true
//! outside a packaged build.

use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};
use tokio::sync::OnceCell;

/// Where the extracted runtime lives: a directory containing `node_modules/`
/// (the SDK + deps) and `manifest.json` (which the bridge itself reads to
/// find each package's ESM entry file — see `pack-bridge-runtime.mjs`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeDir {
    pub dir: PathBuf,
}

#[derive(Debug, Deserialize)]
struct Manifest {
    #[serde(rename = "sdkVersion")]
    sdk_version: String,
    files: Vec<ManifestFile>,
}

#[derive(Debug, Deserialize)]
struct ManifestFile {
    path: String,
    sha256: String,
}

fn fail(context: &str, err: impl std::fmt::Display) -> String {
    format!("{}: {}", context, err)
}

/// Locate the bundled tarball + manifest as shipped by the bundler. Probes
/// a couple of resource-dir layouts, mirroring `bridge_path_candidates`'
/// defensive handling of macOS's out-of-tree resource flattening.
fn bundled_runtime_paths(app: &AppHandle) -> Result<(PathBuf, PathBuf), String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| fail("no resource dir", e))?;
    let candidate_dirs = [
        resource_dir.join("bridge").join("runtime"),
        resource_dir.join("_up_").join("bridge").join("runtime"),
    ];
    for dir in &candidate_dirs {
        let tarball = dir.join("bridge-runtime.tar.zst");
        let manifest = dir.join("manifest.json");
        if tarball.is_file() && manifest.is_file() {
            return Ok((tarball, manifest));
        }
    }
    Err(format!(
        "bridge-runtime.tar.zst / manifest.json not found (looked at: {})",
        candidate_dirs
            .iter()
            .map(|p| p.display().to_string())
            .collect::<Vec<_>>()
            .join(", ")
    ))
}

fn read_manifest(path: &Path) -> Result<Manifest, String> {
    let bytes = std::fs::read(path).map_err(|e| fail(&format!("read {}", path.display()), e))?;
    serde_json::from_slice(&bytes).map_err(|e| fail(&format!("parse {}", path.display()), e))
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut f = std::fs::File::open(path).map_err(|e| fail(&format!("open {}", path.display()), e))?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = f
            .read(&mut buf)
            .map_err(|e| fail(&format!("read {}", path.display()), e))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// Every file the manifest lists exists on disk with a matching hash.
/// Cheap enough to run on every launch (a few thousand small JS files) and
/// catches partial writes / disk corruption that a directory-exists check
/// alone would miss — the exact "corrupted extracted runtime" failure mode
/// ADR 002 calls out.
fn verify_node_modules(node_modules: &Path, manifest: &Manifest) -> bool {
    node_modules.is_dir()
        && manifest
            .files
            .iter()
            .all(|f| matches!(sha256_file(&node_modules.join(&f.path)), Ok(h) if h == f.sha256))
}

fn extract_tarball(tarball: &Path, dest: &Path) -> Result<(), String> {
    let file = std::fs::File::open(tarball).map_err(|e| fail("open tarball", e))?;
    let decoder = zstd::stream::read::Decoder::new(file).map_err(|e| fail("zstd init", e))?;
    tar::Archive::new(decoder)
        .unpack(dest)
        .map_err(|e| fail("tar unpack", e))
}

/// Extract the bundled tarball into
/// `${app_local_data_dir}/hermes-runtime/${sdkVersion}/` if it isn't
/// already there (or fails verification), and return the resolved runtime
/// directory.
///
/// `app_local_data_dir` (not `app_data_dir`) deliberately: on Windows the
/// two diverge (`%LOCALAPPDATA%` vs the roaming `%APPDATA%`), and a ~200 MB
/// runtime has no business round-tripping through the roaming profile on
/// every domain-joined machine's login. macOS/Linux resolve both to the
/// same path, so this is a no-op there.
///
/// Idempotent and safe under concurrent callers: extraction lands in a
/// per-process temp dir first and is renamed into place atomically (same
/// filesystem, since both live under the runtime base dir), so a racing
/// caller either sees the prior valid directory or the fully-extracted new
/// one — never a half-written one. If two callers race the rename, the
/// loser's temp dir is simply discarded once its own result verifies
/// against the (now-shared) winner's directory.
pub fn ensure_runtime_extracted(app: &AppHandle) -> Result<RuntimeDir, String> {
    let (tarball, bundled_manifest_path) = bundled_runtime_paths(app)?;
    let manifest = read_manifest(&bundled_manifest_path)?;

    let runtime_root = app
        .path()
        .app_local_data_dir()
        .map_err(|e| fail("app_local_data_dir", e))?
        .join("hermes-runtime");
    let target = runtime_root.join(&manifest.sdk_version);
    let node_modules = target.join("node_modules");

    if verify_node_modules(&node_modules, &manifest) {
        return Ok(RuntimeDir { dir: target });
    }

    std::fs::create_dir_all(&runtime_root).map_err(|e| fail("create runtime root", e))?;

    let tmp = runtime_root.join(format!(
        ".{}-tmp-{}",
        manifest.sdk_version,
        std::process::id()
    ));
    if tmp.exists() {
        std::fs::remove_dir_all(&tmp).map_err(|e| fail("clear stale tmp dir", e))?;
    }
    std::fs::create_dir_all(&tmp).map_err(|e| fail("create tmp extract dir", e))?;

    let extracted = extract_tarball(&tarball, &tmp).and_then(|()| {
        std::fs::copy(&bundled_manifest_path, tmp.join("manifest.json"))
            .map_err(|e| fail("stage manifest", e))?;
        if verify_node_modules(&tmp.join("node_modules"), &manifest) {
            Ok(())
        } else {
            Err("extracted runtime failed manifest verification".to_string())
        }
    });

    if let Err(e) = extracted {
        let _ = std::fs::remove_dir_all(&tmp);
        return Err(e);
    }

    if let Err(e) = std::fs::rename(&tmp, &target) {
        // A racing extractor may have already renamed its own tmp dir into
        // `target` first. That's fine as long as what landed there verifies
        // — we didn't lose anything, we just did redundant work.
        let _ = std::fs::remove_dir_all(&tmp);
        if !verify_node_modules(&node_modules, &manifest) {
            return Err(fail("rename extracted runtime into place", e));
        }
    }

    Ok(RuntimeDir { dir: target })
}

/// Process-wide cache so the startup prewarm and the first real agent spawn
/// share one extraction instead of racing two copies of a multi-thousand-
/// file unpack. `OnceCell` (not `Lazy`) because `ensure_runtime_extracted`
/// needs the `AppHandle`, which isn't available at static-init time.
static RUNTIME_DIR: OnceCell<Result<RuntimeDir, String>> = OnceCell::const_new();

/// Async, cached wrapper around [`ensure_runtime_extracted`]. Runs the
/// (blocking, filesystem-heavy) extraction on a blocking-pool thread so it
/// never stalls the tokio runtime's async workers.
pub async fn runtime_dir(app: &AppHandle) -> Result<RuntimeDir, String> {
    let app = app.clone();
    RUNTIME_DIR
        .get_or_init(|| async move {
            tokio::task::spawn_blocking(move || ensure_runtime_extracted(&app))
                .await
                .unwrap_or_else(|e| Err(fail("extraction task panicked", e)))
        })
        .await
        .clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_fixture_tarball(dir: &Path, files: &[(&str, &[u8])]) -> (PathBuf, Manifest, Vec<u8>) {
        let node_modules = dir.join("node_modules");
        for (path, contents) in files {
            let full = node_modules.join(path);
            std::fs::create_dir_all(full.parent().unwrap()).unwrap();
            std::fs::write(&full, contents).unwrap();
        }

        let manifest_files: Vec<ManifestFile> = files
            .iter()
            .map(|(path, contents)| ManifestFile {
                path: path.to_string(),
                sha256: {
                    let mut h = Sha256::new();
                    h.update(contents);
                    format!("{:x}", h.finalize())
                },
            })
            .collect();

        let tarball_path = dir.join("bridge-runtime.tar.zst");
        let tar_file = std::fs::File::create(&tarball_path).unwrap();
        let encoder = zstd::stream::write::Encoder::new(tar_file, 3).unwrap();
        let mut builder = tar::Builder::new(encoder);
        builder.append_dir_all("node_modules", &node_modules).unwrap();
        let encoder = builder.into_inner().unwrap();
        encoder.finish().unwrap();

        let manifest_json = serde_json::json!({
            "sdkVersion": "0.3.283",
            "entries": {"pkg": "pkg/index.js"},
            "files": manifest_files.iter().map(|f| serde_json::json!({"path": f.path, "sha256": f.sha256})).collect::<Vec<_>>(),
            "builtAt": "2026-01-01T00:00:00.000Z",
        });
        let manifest_bytes = serde_json::to_vec_pretty(&manifest_json).unwrap();
        std::fs::write(dir.join("manifest.json"), &manifest_bytes).unwrap();

        std::fs::remove_dir_all(&node_modules).unwrap(); // only the tarball should remain in `dir`

        let manifest: Manifest = serde_json::from_slice(&manifest_bytes).unwrap();
        (tarball_path, manifest, manifest_bytes)
    }

    #[test]
    fn extracts_and_verifies_a_fresh_tarball() {
        let src = tempfile::tempdir().unwrap();
        let (tarball, manifest, _) =
            write_fixture_tarball(src.path(), &[("pkg/index.js", b"export default 1;")]);

        let dest = tempfile::tempdir().unwrap();
        extract_tarball(&tarball, dest.path()).unwrap();
        std::fs::copy(src.path().join("manifest.json"), dest.path().join("manifest.json")).unwrap();

        assert!(verify_node_modules(&dest.path().join("node_modules"), &manifest));
    }

    #[test]
    fn verification_fails_on_missing_file() {
        let src = tempfile::tempdir().unwrap();
        let (_, manifest, _) =
            write_fixture_tarball(src.path(), &[("pkg/index.js", b"export default 1;")]);

        let empty = tempfile::tempdir().unwrap();
        assert!(!verify_node_modules(&empty.path().join("node_modules"), &manifest));
    }

    #[test]
    fn verification_fails_on_content_mismatch() {
        let src = tempfile::tempdir().unwrap();
        let (tarball, manifest, _) =
            write_fixture_tarball(src.path(), &[("pkg/index.js", b"export default 1;")]);

        let dest = tempfile::tempdir().unwrap();
        extract_tarball(&tarball, dest.path()).unwrap();
        // Corrupt the extracted file — a truncated/partial write should be
        // caught, not silently treated as "already extracted".
        std::fs::write(
            dest.path().join("node_modules").join("pkg").join("index.js"),
            b"corrupted",
        )
        .unwrap();

        assert!(!verify_node_modules(&dest.path().join("node_modules"), &manifest));
    }

    #[test]
    fn corrupt_tarball_reports_a_clear_error() {
        let dir = tempfile::tempdir().unwrap();
        let bad_tarball = dir.path().join("bad.tar.zst");
        std::fs::write(&bad_tarball, b"not a zstd stream").unwrap();

        let dest = tempfile::tempdir().unwrap();
        let err = extract_tarball(&bad_tarball, dest.path()).unwrap_err();
        assert!(err.contains("zstd init") || err.contains("tar unpack"), "{err}");
    }

    #[test]
    fn manifest_mismatch_triggers_re_extract() {
        // Simulate an app upgrade: the bundled manifest lists a file that
        // isn't in the previously-extracted dir (an SDK bump added it).
        // Verification must fail so the caller re-extracts rather than
        // handing back a stale runtime.
        let src = tempfile::tempdir().unwrap();
        let (_, old_manifest, _) =
            write_fixture_tarball(src.path(), &[("pkg/index.js", b"v1")]);

        let src2 = tempfile::tempdir().unwrap();
        let (_, new_manifest, _) = write_fixture_tarball(
            src2.path(),
            &[("pkg/index.js", b"v1"), ("pkg/extra.js", b"v2-only")],
        );

        let dest = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dest.path().join("node_modules").join("pkg")).unwrap();
        std::fs::write(
            dest.path().join("node_modules").join("pkg").join("index.js"),
            b"v1",
        )
        .unwrap();

        assert!(verify_node_modules(&dest.path().join("node_modules"), &old_manifest));
        assert!(!verify_node_modules(&dest.path().join("node_modules"), &new_manifest));
    }
}
