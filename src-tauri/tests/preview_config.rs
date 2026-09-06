//! Locks the invariants of the unofficial SSH preview bundle config.
//!
//! `tauri build --config tauri.preview.conf.json` layers three files with JSON
//! Merge Patch (RFC 7396): `tauri.conf.json`, then `tauri.windows.conf.json`,
//! then the preview file. These tests replay that merge so a later edit cannot
//! quietly re-enable the updater, drop the separate identity, or let the
//! preview installer reach into a stable Terax install.

use serde_json::{Map, Value};
use std::path::{Path, PathBuf};

const STABLE_IDENTIFIER: &str = "app.crynta.terax";
const PREVIEW_IDENTIFIER: &str = "io.github.stephenstack.terax.sshpreview";
const PREVIEW_VERSION: &str = "0.8.6-ssh.2";

/// RFC 7396. A `null` in the patch deletes the key; objects merge recursively;
/// every other value, arrays included, replaces wholesale. Same semantics as
/// the `json_patch::merge` the Tauri CLI applies.
fn merge_patch(target: &mut Value, patch: &Value) {
    let Value::Object(patch) = patch else {
        *target = patch.clone();
        return;
    };
    if !target.is_object() {
        *target = Value::Object(Map::new());
    }
    let map = target.as_object_mut().expect("target is an object");
    for (key, value) in patch {
        if value.is_null() {
            map.remove(key);
        } else {
            merge_patch(map.entry(key.clone()).or_insert(Value::Null), value);
        }
    }
}

fn conf_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).to_path_buf()
}

fn read(name: &str) -> Value {
    let path = conf_dir().join(name);
    let raw = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
    serde_json::from_str(&raw).unwrap_or_else(|error| panic!("parse {}: {error}", path.display()))
}

/// The config the Windows preview bundle is actually built from.
fn merged_preview() -> Value {
    let mut config = read("tauri.conf.json");
    merge_patch(&mut config, &read("tauri.windows.conf.json"));
    merge_patch(&mut config, &read("tauri.preview.conf.json"));
    config
}

#[test]
fn merge_patch_deletes_keys_given_null() {
    let mut target = serde_json::json!({"plugins": {"updater": {"pubkey": "k"}, "store": {}}});
    merge_patch(
        &mut target,
        &serde_json::json!({"plugins": {"updater": null}}),
    );
    assert_eq!(target, serde_json::json!({"plugins": {"store": {}}}));
}

#[test]
fn merge_patch_replaces_arrays_wholesale() {
    let mut target = serde_json::json!({"targets": ["nsis", "msi"]});
    merge_patch(&mut target, &serde_json::json!({"targets": ["nsis"]}));
    assert_eq!(target["targets"], serde_json::json!(["nsis"]));
}

#[test]
fn preview_build_has_no_updater_configuration() {
    let config = merged_preview();
    let plugins = config["plugins"].as_object().expect("plugins object");
    assert!(
        !plugins.contains_key("updater"),
        "preview config still carries plugins.updater: {plugins:?}"
    );
    assert_eq!(
        config["bundle"]["createUpdaterArtifacts"],
        Value::Bool(false),
        "preview must not emit updater artifacts or a signature"
    );
}

#[test]
fn stable_build_keeps_its_updater() {
    let stable = read("tauri.conf.json");
    assert!(
        stable["plugins"]["updater"]["pubkey"].is_string(),
        "stable config lost its updater; the preview override would be a no-op"
    );
    assert!(
        stable["plugins"]["updater"]["endpoints"]
            .as_array()
            .is_some_and(|endpoints| !endpoints.is_empty()),
        "stable config lost its updater endpoints"
    );
}

#[test]
fn preview_installs_beside_stable_rather_than_over_it() {
    let config = merged_preview();
    assert_eq!(config["identifier"], PREVIEW_IDENTIFIER);
    assert_ne!(config["identifier"], STABLE_IDENTIFIER);
    assert_eq!(config["productName"], "Terax SSH Preview");
    assert_eq!(config["version"], PREVIEW_VERSION);

    let hooks = config["bundle"]["windows"]["nsis"]["installerHooks"]
        .as_str()
        .expect("preview installer hooks");
    let stable_hooks = read("tauri.conf.json")["bundle"]["windows"]["nsis"]["installerHooks"]
        .as_str()
        .expect("stable installer hooks")
        .to_string();
    assert_ne!(
        hooks, stable_hooks,
        "preview must not run the stable shell-verb hooks; uninstalling it would \
         delete the stable install's context menu entries"
    );
    assert!(
        conf_dir().join(hooks).is_file(),
        "missing hooks file {hooks}"
    );

    assert_eq!(
        config["bundle"]["fileAssociations"],
        serde_json::json!([]),
        "preview must not claim the file types a stable install registers"
    );
}

#[test]
fn preview_is_windows_nsis_only() {
    let config = merged_preview();
    assert_eq!(config["bundle"]["targets"], serde_json::json!(["nsis"]));
    assert_eq!(
        config["bundle"]["windows"]["nsis"]["installMode"], "currentUser",
        "an unsigned preview must never ask for admin rights"
    );
}

#[test]
fn preview_identifies_itself_as_unofficial() {
    let config = merged_preview();
    let publisher = config["bundle"]["publisher"].as_str().expect("publisher");
    assert!(
        publisher.to_lowercase().contains("unofficial"),
        "publisher must read as unofficial, got {publisher:?}"
    );
    let title = config["app"]["windows"][0]["title"]
        .as_str()
        .expect("main window title");
    assert!(
        title.contains("SSH Preview"),
        "window title must name the preview, got {title:?}"
    );
}

/// The Windows platform file replaces the whole `app.windows` array, and the
/// preview file replaces it again. Anything the platform file sets and the
/// preview file forgets is silently lost, so they must agree.
#[test]
fn preview_window_keeps_every_windows_platform_setting() {
    let platform = read("tauri.windows.conf.json");
    let preview = read("tauri.preview.conf.json");
    let platform_window = platform["app"]["windows"][0]
        .as_object()
        .expect("platform window");
    let preview_window = preview["app"]["windows"][0]
        .as_object()
        .expect("preview window");

    for (key, value) in platform_window {
        let actual = preview_window
            .get(key)
            .unwrap_or_else(|| panic!("preview window drops {key:?} from tauri.windows.conf.json"));
        if key == "title" {
            continue;
        }
        assert_eq!(actual, value, "preview window disagrees on {key:?}");
    }
}
