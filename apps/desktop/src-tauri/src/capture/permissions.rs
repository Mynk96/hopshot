//! Screen-recording permission (ARCHITECTURE §5.2).
//!
//! Only macOS gates reading the screen. Without the permission `xcap` does not fail — it
//! returns an image of the desktop wallpaper with every window missing, which looks like a
//! capture bug rather than a permissions problem. So the check has to happen *before* the
//! overlay opens (PRD F1.2 acceptance), not after a confusing screenshot.

use serde::Serialize;

use crate::platform;

/// `permissions_status()` in ARCHITECTURE §5.4.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ScreenAccess {
    Granted,
    Denied,
    /// macOS can report "not determined" before the first request.
    Unknown,
}

impl ScreenAccess {
    pub fn is_usable(self) -> bool {
        // "Unknown" means macOS has not been asked yet. Attempting the capture is what
        // triggers the system prompt, so it is not a reason to refuse.
        !matches!(self, ScreenAccess::Denied)
    }
}

/// Current screen-recording permission.
pub fn status() -> ScreenAccess {
    platform::screen_access()
}

/// Open the OS pane where the user can grant it (DESIGN §5: "Fix in one click →").
pub fn open_settings() {
    platform::open_screen_settings();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_an_outright_denial_blocks_a_capture() {
        assert!(ScreenAccess::Granted.is_usable());
        assert!(
            ScreenAccess::Unknown.is_usable(),
            "the first capture is what raises the macOS prompt"
        );
        assert!(!ScreenAccess::Denied.is_usable());
    }

    /// Windows has no such permission, so a capture must never be blocked there.
    #[cfg(target_os = "windows")]
    #[test]
    fn windows_always_allows_capture() {
        assert_eq!(status(), ScreenAccess::Granted);
    }
}
