//! Build channel. Baked in at compile time by `build.rs` from `TERAX_CHANNEL`,
//! so nothing is read, resolved or branched on at runtime.
//!
//! `preview` marks an unofficial, unsigned side-by-side build. It ships with no
//! auto-updater and keeps its own on-disk control directory so it cannot reach
//! into a stable install.

/// Value this binary was compiled with. Empty when `TERAX_CHANNEL` was unset.
const RAW: &str = env!("TERAX_CHANNEL");

/// Only an exact `preview` selects the preview channel. Every other value,
/// the empty string included, is stable, so a typo or a dropped environment
/// variable can never silently strip the updater out of a release build.
pub fn is_preview_channel(raw: &str) -> bool {
    raw.trim().eq_ignore_ascii_case("preview")
}

/// Preview bundles also strip `plugins.updater` from their Tauri config, and
/// the plugin's `Config` requires `pubkey`, so registering it on a preview
/// build would fail plugin setup instead of merely being unused.
pub fn updater_enabled(raw: &str) -> bool {
    !is_preview_channel(raw)
}

/// Name of the shared cache directory holding `control.json`. It is keyed by
/// channel because the path is a single fixed file: a preview install writing
/// the stable name would point the `terax` CLI at whichever instance started
/// last.
pub fn control_dir_name(raw: &str) -> &'static str {
    if is_preview_channel(raw) {
        "terax-ssh-preview"
    } else {
        "terax"
    }
}

pub fn is_preview() -> bool {
    is_preview_channel(RAW)
}

pub fn updater_is_enabled() -> bool {
    updater_enabled(RAW)
}

pub fn control_dir() -> &'static str {
    control_dir_name(RAW)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preview_channel_disables_the_updater() {
        assert!(is_preview_channel("preview"));
        assert!(!updater_enabled("preview"));
    }

    #[test]
    fn surrounding_whitespace_and_case_still_select_preview() {
        for raw in ["  preview", "preview\n", "Preview", "PREVIEW"] {
            assert!(is_preview_channel(raw), "{raw:?} should be preview");
            assert!(!updater_enabled(raw), "{raw:?} should have no updater");
        }
    }

    #[test]
    fn anything_else_is_stable_and_keeps_the_updater() {
        for raw in [
            "",
            " ",
            "stable",
            "previews",
            "pre-view",
            "ssh-preview",
            "1",
        ] {
            assert!(!is_preview_channel(raw), "{raw:?} should not be preview");
            assert!(updater_enabled(raw), "{raw:?} should keep the updater");
        }
    }

    #[test]
    fn control_dir_is_isolated_per_channel() {
        assert_eq!(control_dir_name("preview"), "terax-ssh-preview");
        assert_eq!(control_dir_name(""), "terax");
        assert_ne!(control_dir_name("preview"), control_dir_name("stable"));
    }

    #[test]
    fn compiled_channel_agrees_with_the_updater_gate() {
        assert_eq!(is_preview(), !updater_is_enabled());
        assert_eq!(control_dir(), control_dir_name(RAW));
    }
}
