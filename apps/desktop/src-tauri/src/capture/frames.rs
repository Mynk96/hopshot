//! `grab_all()` — freeze every monitor with `xcap` and keep the RgbaImage in memory.
//!
//! The 300 ms hotkey→overlay budget (ARCHITECTURE §5.2) is mostly spent here, so the grab
//! and the display encode are timed separately and logged: when the budget is missed we
//! need to know which half to attack.
//!
//! Display frames are encoded as **BMP**, not PNG. ARCHITECTURE §5.2 allows either and says
//! to fall back to raw if PNG is slow — at 4K, PNG costs hundreds of milliseconds even on
//! `Compression::Fast`, while BMP is a header plus a memcpy. The saved capture is still PNG
//! (PRD F1.5); this is only what the overlay renders.

use std::io::Cursor;
use std::sync::Mutex;
use std::time::Instant;

use image::{ImageFormat, RgbaImage};
use thiserror::Error;
use xcap::Monitor;

use crate::capture::crop::{MonitorBounds, PhysicalRect};

#[derive(Debug, Error)]
pub enum FrameError {
    #[error("the screen could not be read: {0}")]
    Capture(String),
    #[error("the frame could not be encoded: {0}")]
    Encode(String),
    #[error("no monitors were found")]
    NoMonitors,
}

/// One frozen monitor.
pub struct Frame {
    /// Stable within a session; the overlay window label and the `frame://` path both use it.
    pub monitor_id: u32,
    pub bounds: MonitorBounds,
    /// Physical-resolution pixels, exactly as captured.
    pub image: RgbaImage,
    /// The same pixels as BMP, ready for the `frame://` protocol.
    pub display_bytes: Vec<u8>,
}

impl Frame {
    /// Crop out a physical rectangle. The rect is assumed to be inside the frame already —
    /// `crop::to_physical` clamps it.
    pub fn crop(&self, rect: PhysicalRect) -> RgbaImage {
        image::imageops::crop_imm(&self.image, rect.x, rect.y, rect.width, rect.height).to_image()
    }
}

/// The frozen frames from the most recent grab, held until the overlay closes.
///
/// A capture is modal — one set of frames at a time — so a single slot is enough, and
/// dropping it on cancel is what frees the (large) bitmaps.
#[derive(Default)]
pub struct FrozenFrames(Mutex<Vec<Frame>>);

impl FrozenFrames {
    pub fn replace(&self, frames: Vec<Frame>) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = frames;
    }

    pub fn clear(&self) {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).clear();
    }

    /// Run `f` against one frozen frame, if it is still held.
    pub fn with<T>(&self, monitor_id: u32, f: impl FnOnce(&Frame) -> T) -> Option<T> {
        let frames = self.0.lock().unwrap_or_else(|e| e.into_inner());
        frames.iter().find(|m| m.monitor_id == monitor_id).map(f)
    }

    /// The display bytes for one monitor, copied out for the protocol handler.
    pub fn display_bytes(&self, monitor_id: u32) -> Option<Vec<u8>> {
        self.with(monitor_id, |frame| frame.display_bytes.clone())
    }

    pub fn is_empty(&self) -> bool {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).is_empty()
    }
}

/// Name an `xcap` read so a failure says which property could not be read.
fn read<T>(what: &str, value: Result<T, xcap::XCapError>) -> Result<T, FrameError> {
    value.map_err(|e| FrameError::Capture(format!("{what}: {e}")))
}

/// xcap reports monitor geometry in different spaces per platform, so the conversion to
/// [`MonitorBounds`] has to know which one it is looking at.
///
/// * Windows — `dmPosition` / `dmPelsWidth` from `DEVMODE`, i.e. **physical** pixels.
/// * macOS — `CGDisplayBounds`, i.e. **logical** points.
///
/// Getting this backwards is invisible at 100% scale and crops the wrong region on every
/// HiDPI display, which is exactly the sort of bug CLAUDE.md's DPI gotcha warns about.
fn bounds_of(monitor: &Monitor) -> Result<MonitorBounds, FrameError> {
    let x = read("monitor x", monitor.x())?;
    let y = read("monitor y", monitor.y())?;
    let width = read("monitor width", monitor.width())?;
    let height = read("monitor height", monitor.height())?;
    let scale = f64::from(read("monitor scale factor", monitor.scale_factor())?);

    #[cfg(target_os = "windows")]
    let bounds = MonitorBounds::from_physical(x, y, width, height, scale);
    #[cfg(target_os = "macos")]
    let bounds = MonitorBounds::from_logical(x, y, width, height, scale);

    Ok(bounds)
}

/// Monitor geometry without capturing anything.
///
/// Used at startup to pre-create the overlay windows, where paying for a full grab would
/// add seconds to launch for frames nobody has asked for yet.
pub fn monitor_bounds() -> Result<Vec<(u32, MonitorBounds)>, FrameError> {
    let monitors = Monitor::all().map_err(|e| FrameError::Capture(e.to_string()))?;
    if monitors.is_empty() {
        return Err(FrameError::NoMonitors);
    }

    monitors
        .iter()
        .map(|monitor| {
            let id = read("monitor id", monitor.id())?;
            Ok((id, bounds_of(monitor)?))
        })
        .collect()
}

/// Take one throwaway capture on a background thread so the first real one is not slow.
///
/// Measured on Windows: the first `capture_image()` of a session costs ~370 ms against
/// ~47 ms for every one after it — the graphics stack is being set up, not the screenshot
/// taken. Paying that during startup, where nobody is waiting, keeps the user's first
/// hotkey press inside the 300 ms budget instead of blowing it by 120 ms.
pub fn prewarm_capture() {
    std::thread::spawn(|| {
        let started = Instant::now();
        let warmed = Monitor::all()
            .ok()
            .and_then(|monitors| monitors.into_iter().next())
            .map(|monitor| monitor.capture_image().is_ok())
            .unwrap_or(false);

        if warmed {
            log::info!(
                "capture path warmed in {:.1} ms",
                started.elapsed().as_secs_f64() * 1000.0
            );
        } else {
            // Not fatal: the first real capture just pays the cost instead.
            log::debug!("capture warm-up did not complete");
        }
    });
}

/// Freeze every monitor.
///
/// Returns the frames in `xcap` order. Timings for the grab and the encode are logged
/// separately against the ARCHITECTURE §5.2 budget.
pub fn grab_all() -> Result<Vec<Frame>, FrameError> {
    let started = Instant::now();

    let monitors = Monitor::all().map_err(|e| FrameError::Capture(e.to_string()))?;
    if monitors.is_empty() {
        return Err(FrameError::NoMonitors);
    }
    let enumerate_ms = started.elapsed().as_secs_f64() * 1000.0;

    let mut frames = Vec::with_capacity(monitors.len());
    let mut grab_total = 0.0;
    let mut encode_total = 0.0;

    for monitor in &monitors {
        let monitor_id = monitor
            .id()
            .map_err(|e| FrameError::Capture(format!("monitor id: {e}")))?;
        let bounds = bounds_of(monitor)?;

        let grab_started = Instant::now();
        let image = monitor
            .capture_image()
            .map_err(|e| FrameError::Capture(format!("monitor {monitor_id}: {e}")))?;
        let grab_ms = grab_started.elapsed().as_secs_f64() * 1000.0;
        grab_total += grab_ms;

        let encode_started = Instant::now();
        let display_bytes = encode_for_display(&image)?;
        let encode_ms = encode_started.elapsed().as_secs_f64() * 1000.0;
        encode_total += encode_ms;

        log::info!(
            "monitor {monitor_id}: {}x{} @{}x — grab {grab_ms:.1} ms, encode {encode_ms:.1} ms ({} KiB)",
            image.width(),
            image.height(),
            bounds.scale_factor,
            display_bytes.len() / 1024,
        );

        frames.push(Frame {
            monitor_id,
            bounds,
            image,
            display_bytes,
        });
    }

    log::info!(
        "grab_all: {} monitor(s) in {:.1} ms (enumerate {enumerate_ms:.1} + grab {grab_total:.1} + encode {encode_total:.1})",
        frames.len(),
        started.elapsed().as_secs_f64() * 1000.0,
    );

    Ok(frames)
}

/// Bytes of `BITMAPFILEHEADER` + `BITMAPINFOHEADER`.
const BMP_HEADER_LEN: u32 = 14 + 40;

/// Encode one frame for the overlay: a 32-bit top-down BMP, written by hand.
///
/// `image`'s own BMP encoder goes through its generic per-pixel writer and measured ~320 ms
/// for a single 1080p frame — on its own more than the 300 ms budget for the whole capture.
/// A BMP is a 54-byte header followed by raw rows, so writing it directly turns the encode
/// into one pass that swaps R and B (BMP is BGRA) and copies.
///
/// The height is written negative, which is how BMP says "top-down"; the default bottom-up
/// layout would hand the webview an upside-down screenshot.
fn encode_for_display(image: &RgbaImage) -> Result<Vec<u8>, FrameError> {
    let width = image.width();
    let height = image.height();

    // 32 bits per pixel means rows are already 4-byte aligned, so there is no padding.
    let pixels = image.as_raw();
    let data_len = u32::try_from(pixels.len())
        .map_err(|_| FrameError::Encode("frame is too large for a BMP".into()))?;

    // Allocated once at full size: the pixel pass below writes into it directly, so there
    // are no capacity checks in the hot loop.
    let mut out = Vec::with_capacity(BMP_HEADER_LEN as usize + pixels.len());

    // BITMAPFILEHEADER
    out.extend_from_slice(b"BM");
    out.extend_from_slice(&(BMP_HEADER_LEN + data_len).to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes()); // reserved1
    out.extend_from_slice(&0u16.to_le_bytes()); // reserved2
    out.extend_from_slice(&BMP_HEADER_LEN.to_le_bytes());

    // BITMAPINFOHEADER
    out.extend_from_slice(&40u32.to_le_bytes());
    out.extend_from_slice(&(width as i32).to_le_bytes());
    out.extend_from_slice(&(-(height as i32)).to_le_bytes()); // negative = top-down
    out.extend_from_slice(&1u16.to_le_bytes()); // planes
    out.extend_from_slice(&32u16.to_le_bytes()); // bits per pixel
    out.extend_from_slice(&0u32.to_le_bytes()); // BI_RGB, uncompressed
    out.extend_from_slice(&data_len.to_le_bytes());
    out.extend_from_slice(&0i32.to_le_bytes()); // x pixels per metre
    out.extend_from_slice(&0i32.to_le_bytes()); // y pixels per metre
    out.extend_from_slice(&0u32.to_le_bytes()); // palette colours used
    out.extend_from_slice(&0u32.to_le_bytes()); // palette colours required

    // RGBA → BGRA. Writing into an already-sized tail with paired `chunks_exact` lets the
    // optimiser drop the bounds checks and vectorise; pushing four bytes at a time through
    // `extend_from_slice` instead measured roughly 2.5x slower on a 1080p frame.
    let header_len = out.len();
    out.resize(header_len + pixels.len(), 0);
    let destination = &mut out[header_len..];

    for (target, source) in destination.chunks_exact_mut(4).zip(pixels.chunks_exact(4)) {
        target[0] = source[2];
        target[1] = source[1];
        target[2] = source[0];
        target[3] = source[3];
    }

    Ok(out)
}

/// Encode a cropped selection for saving to disk (PRD F1.5 wants a PNG).
pub fn encode_png(image: &RgbaImage) -> Result<Vec<u8>, FrameError> {
    let mut buffer = Cursor::new(Vec::new());
    image
        .write_to(&mut buffer, ImageFormat::Png)
        .map_err(|e| FrameError::Encode(e.to_string()))?;
    Ok(buffer.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_frames_are_bmp() {
        let image = RgbaImage::new(4, 4);
        let bytes = encode_for_display(&image).expect("encode");
        assert_eq!(&bytes[..2], b"BM", "the overlay expects a BMP header");
    }

    #[test]
    fn saved_captures_are_png() {
        let image = RgbaImage::new(4, 4);
        let bytes = encode_png(&image).expect("encode");
        assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n");
    }

    #[test]
    fn cropping_takes_the_requested_pixels() {
        let mut image = RgbaImage::new(10, 10);
        image.put_pixel(3, 4, image::Rgba([1, 2, 3, 255]));

        let frame = Frame {
            monitor_id: 1,
            bounds: MonitorBounds::from_physical(0, 0, 10, 10, 1.0),
            image,
            display_bytes: Vec::new(),
        };
        let cropped = frame.crop(PhysicalRect {
            x: 2,
            y: 3,
            width: 4,
            height: 4,
        });

        assert_eq!(cropped.dimensions(), (4, 4));
        assert_eq!(*cropped.get_pixel(1, 1), image::Rgba([1, 2, 3, 255]));
    }

    #[test]
    fn frozen_frames_hand_back_only_what_they_hold() {
        let frames = FrozenFrames::default();
        assert!(frames.is_empty());

        frames.replace(vec![Frame {
            monitor_id: 7,
            bounds: MonitorBounds::from_physical(0, 0, 2, 2, 1.0),
            image: RgbaImage::new(2, 2),
            display_bytes: vec![1, 2, 3],
        }]);

        assert_eq!(frames.display_bytes(7), Some(vec![1, 2, 3]));
        assert_eq!(frames.display_bytes(8), None);

        frames.clear();
        assert!(frames.is_empty());
        assert_eq!(frames.display_bytes(7), None);
    }
}
