//! Clipboard writes via `arboard` (PRD F2.5, F1.5).
//!
//! `arboard` owns the clipboard only while its handle is alive. On Windows that is fine —
//! the bytes are handed to the OS — but on X11 the owner must stay running; that does not
//! affect Hopshot's two targets, so the handle is created per call and dropped.

use std::borrow::Cow;
use std::path::Path;

use arboard::{Clipboard, ImageData};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ClipboardError {
    #[error("the clipboard is not available: {0}")]
    Unavailable(String),
    #[error("that image could not be read: {0}")]
    Decode(String),
}

/// Put a PNG on the clipboard as an image, so it pastes into Slack, Word and browsers
/// rather than arriving as a file path (PRD F2.5).
pub fn copy_image(path: &Path) -> Result<(), ClipboardError> {
    let decoded = image::open(path).map_err(|e| ClipboardError::Decode(e.to_string()))?;
    let rgba = decoded.to_rgba8();
    let (width, height) = rgba.dimensions();

    let image = ImageData {
        width: width as usize,
        height: height as usize,
        bytes: Cow::Owned(rgba.into_raw()),
    };

    let mut clipboard = Clipboard::new().map_err(|e| ClipboardError::Unavailable(e.to_string()))?;
    clipboard
        .set_image(image)
        .map_err(|e| ClipboardError::Unavailable(e.to_string()))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_file_is_a_decode_error_not_a_panic() {
        let nowhere = std::env::temp_dir().join("hopshot-not-an-image.png");
        assert!(matches!(
            copy_image(&nowhere),
            Err(ClipboardError::Decode(_))
        ));
    }
}
