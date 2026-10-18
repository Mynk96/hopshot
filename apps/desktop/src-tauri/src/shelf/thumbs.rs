//! Thumbnails: `thumbs/{id}.png`, at most 320 px wide (ARCHITECTURE §5.3).
//!
//! The shelf renders 184 px-wide cards, so a 320 px thumb covers a 2x display exactly and
//! keeps the webview from decoding a full 4K PNG per card.

use std::path::{Path, PathBuf};

use image::imageops::FilterType;
use image::RgbaImage;
use thiserror::Error;

/// ARCHITECTURE §5.3: "max 320 px wide".
pub const MAX_WIDTH: u32 = 320;

#[derive(Debug, Error)]
pub enum ThumbError {
    #[error("the thumbnail could not be written: {0}")]
    Write(String),
}

/// `thumbs/` under the app-data dir.
pub fn thumbs_dir(app_data: &Path) -> PathBuf {
    app_data.join("thumbs")
}

/// Width and height a thumbnail should have, preserving aspect ratio.
///
/// Images already narrower than the cap are left alone rather than upscaled — blowing a
/// 100 px capture up to 320 px would only blur it.
pub fn target_size(width: u32, height: u32) -> (u32, u32) {
    if width <= MAX_WIDTH || width == 0 {
        return (width.max(1), height.max(1));
    }
    let scaled = (u64::from(height) * u64::from(MAX_WIDTH) / u64::from(width)) as u32;
    (MAX_WIDTH, scaled.max(1))
}

/// Write `thumbs/{id}.png` for a capture and return its path.
pub fn write(app_data: &Path, id: &str, image: &RgbaImage) -> Result<PathBuf, ThumbError> {
    let dir = thumbs_dir(app_data);
    std::fs::create_dir_all(&dir).map_err(|e| ThumbError::Write(e.to_string()))?;

    let (width, height) = target_size(image.width(), image.height());
    let path = dir.join(format!("{id}.png"));

    // Triangle rather than Lanczos: the result is 184 px on screen, and Lanczos on a 4K
    // source measurably costs more than it shows.
    let thumb = image::imageops::resize(image, width, height, FilterType::Triangle);
    thumb
        .save(&path)
        .map_err(|e| ThumbError::Write(e.to_string()))?;

    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wide_images_are_capped_at_320() {
        assert_eq!(target_size(3840, 2160), (320, 180));
        assert_eq!(target_size(1920, 1080), (320, 180));
        // 16:10
        assert_eq!(target_size(1280, 800), (320, 200));
    }

    #[test]
    fn narrow_images_are_left_alone() {
        assert_eq!(target_size(320, 200), (320, 200));
        assert_eq!(target_size(100, 80), (100, 80));
    }

    #[test]
    fn a_sliver_never_rounds_away_to_zero() {
        // 4000x3 would scale to 0.24 px tall.
        let (width, height) = target_size(4000, 3);
        assert_eq!(width, 320);
        assert!(height >= 1, "a zero-height thumbnail cannot be encoded");
    }

    #[test]
    fn degenerate_sizes_do_not_panic() {
        assert_eq!(target_size(0, 0), (1, 1));
    }

    #[test]
    fn writing_produces_a_capped_png() {
        let dir = std::env::temp_dir().join(format!("hopshot-thumb-{}", std::process::id()));
        let image = RgbaImage::new(1920, 1080);

        let path = write(&dir, "abc", &image).expect("write");
        assert!(path.ends_with("abc.png"));

        let written = image::open(&path).expect("read back");
        assert_eq!((written.width(), written.height()), (320, 180));

        std::fs::remove_dir_all(&dir).ok();
    }
}
