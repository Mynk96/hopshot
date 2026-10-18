//! Crop math. `to_physical(rect, scale_factor)` needs unit tests at 1.0, 1.25, 1.5 and 2.0
//! and for a monitor with a negative origin (CLAUDE.md rule 8).
//!
//! Two coordinate spaces meet here:
//!
//! * **Logical / CSS px** — what the overlay webview works in, and what the OS uses to lay
//!   monitors out next to each other. A monitor left of the primary one has a negative
//!   origin; a monitor above it has a negative `y`.
//! * **Physical px** — what `xcap` captured. This is the only space the crop may use,
//!   because the frozen frame is a physical-resolution bitmap.
//!
//! Every conversion goes through *that monitor's* scale factor. Mixed-DPI setups are the
//! normal case on Windows (CLAUDE.md "Known platform gotchas"), so a single global scale
//! factor would silently crop the wrong pixels on the secondary monitor.

use serde::{Deserialize, Serialize};

/// A rectangle in CSS px, relative to the overlay window's own top-left corner.
///
/// The overlay covers exactly one monitor, so this is already monitor-local: the monitor's
/// origin must *not* be added here (see `negative_origin_does_not_leak_into_the_crop`).
#[derive(Debug, Clone, Copy, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogicalRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// A rectangle in physical px inside a frozen frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhysicalRect {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

/// Where a monitor sits and how big its frame is.
///
/// `logical_*` places the overlay window; `physical_*` matches the captured frame. Both are
/// stored because neither can be derived from the other reliably — rounding at 125% and
/// 150% means `physical / scale` is not always an integer.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MonitorBounds {
    pub logical_x: f64,
    pub logical_y: f64,
    pub logical_width: f64,
    pub logical_height: f64,
    pub physical_width: u32,
    pub physical_height: u32,
    pub scale_factor: f64,
}

impl MonitorBounds {
    /// Build from a monitor's physical frame, as reported on Windows.
    pub fn from_physical(x: i32, y: i32, width: u32, height: u32, scale_factor: f64) -> Self {
        let scale = if scale_factor > 0.0 { scale_factor } else { 1.0 };
        Self {
            logical_x: f64::from(x) / scale,
            logical_y: f64::from(y) / scale,
            logical_width: f64::from(width) / scale,
            logical_height: f64::from(height) / scale,
            physical_width: width,
            physical_height: height,
            scale_factor: scale,
        }
    }

    /// Build from a monitor's logical frame, as reported on macOS by `CGDisplayBounds`.
    pub fn from_logical(x: i32, y: i32, width: u32, height: u32, scale_factor: f64) -> Self {
        let scale = if scale_factor > 0.0 { scale_factor } else { 1.0 };
        Self {
            logical_x: f64::from(x),
            logical_y: f64::from(y),
            logical_width: f64::from(width),
            logical_height: f64::from(height),
            physical_width: (f64::from(width) * scale).round() as u32,
            physical_height: (f64::from(height) * scale).round() as u32,
            scale_factor: scale,
        }
    }

    /// Does this monitor contain a point given in the desktop's global logical space?
    ///
    /// Used to find the monitor under the cursor for full-screen capture (PRD F1.4) and for
    /// a click without a drag (PRD F1.3).
    pub fn contains_global(&self, x: f64, y: f64) -> bool {
        x >= self.logical_x
            && y >= self.logical_y
            && x < self.logical_x + self.logical_width
            && y < self.logical_y + self.logical_height
    }

    /// Translate a point from the global logical space into this monitor's local space.
    pub fn global_to_local(&self, x: f64, y: f64) -> (f64, f64) {
        (x - self.logical_x, y - self.logical_y)
    }

    /// The whole monitor, for full-screen capture (PRD F1.4).
    pub fn full_frame(&self) -> PhysicalRect {
        PhysicalRect {
            x: 0,
            y: 0,
            width: self.physical_width,
            height: self.physical_height,
        }
    }
}

/// Convert a monitor-local CSS-px rectangle into physical pixels inside the frozen frame.
///
/// Edges are rounded independently and the width is taken as the difference, rather than
/// rounding the width itself. At 125% a 100 px drag starting at x=10.5 is then exactly the
/// pixels the user saw highlighted; rounding the width separately drifts by a pixel.
///
/// Returns `None` when nothing is left after clamping — a drag that finished off-screen, or
/// a selection too small to be an image.
pub fn to_physical(rect: LogicalRect, bounds: &MonitorBounds) -> Option<PhysicalRect> {
    let scale = bounds.scale_factor;

    // Normalise so a right-to-left or bottom-to-top drag works the same way.
    let left = rect.x.min(rect.x + rect.width);
    let top = rect.y.min(rect.y + rect.height);
    let right = rect.x.max(rect.x + rect.width);
    let bottom = rect.y.max(rect.y + rect.height);

    let max_x = f64::from(bounds.physical_width);
    let max_y = f64::from(bounds.physical_height);

    let left = (left * scale).round().clamp(0.0, max_x);
    let top = (top * scale).round().clamp(0.0, max_y);
    let right = (right * scale).round().clamp(0.0, max_x);
    let bottom = (bottom * scale).round().clamp(0.0, max_y);

    let width = (right - left) as u32;
    let height = (bottom - top) as u32;
    if width == 0 || height == 0 {
        return None;
    }

    Some(PhysicalRect {
        x: left as u32,
        y: top as u32,
        width,
        height,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 1920x1080 at the given scale, origin at 0,0.
    fn monitor(scale: f64) -> MonitorBounds {
        MonitorBounds::from_physical(
            0,
            0,
            (1920.0 * scale) as u32,
            (1080.0 * scale) as u32,
            scale,
        )
    }

    fn rect(x: f64, y: f64, width: f64, height: f64) -> LogicalRect {
        LogicalRect {
            x,
            y,
            width,
            height,
        }
    }

    #[test]
    fn scale_1_0_is_the_identity() {
        let got = to_physical(rect(100.0, 50.0, 400.0, 300.0), &monitor(1.0)).expect("rect");
        assert_eq!(
            got,
            PhysicalRect {
                x: 100,
                y: 50,
                width: 400,
                height: 300
            }
        );
    }

    #[test]
    fn scale_1_25_rounds_edges_not_the_size() {
        // 10.5 → 13.125 → 13, and 110.5 → 138.125 → 138, so the width is 125, not 126.
        let got = to_physical(rect(10.5, 20.0, 100.0, 80.0), &monitor(1.25)).expect("rect");
        assert_eq!(
            got,
            PhysicalRect {
                x: 13,
                y: 25,
                width: 125,
                height: 100
            }
        );
    }

    #[test]
    fn scale_1_5_doubles_and_halves_cleanly() {
        let got = to_physical(rect(100.0, 50.0, 400.0, 300.0), &monitor(1.5)).expect("rect");
        assert_eq!(
            got,
            PhysicalRect {
                x: 150,
                y: 75,
                width: 600,
                height: 450
            }
        );
    }

    #[test]
    fn scale_2_0_is_retina() {
        let got = to_physical(rect(100.0, 50.0, 400.0, 300.0), &monitor(2.0)).expect("rect");
        assert_eq!(
            got,
            PhysicalRect {
                x: 200,
                y: 100,
                width: 800,
                height: 600
            }
        );
    }

    /// The rect arrives monitor-local, so a negative origin must not shift the crop. If
    /// someone "fixes" `to_physical` by adding the monitor origin, this fails.
    #[test]
    fn negative_origin_does_not_leak_into_the_crop() {
        let left_of_primary = MonitorBounds::from_physical(-2560, -300, 2560, 1440, 2.0);
        assert_eq!(left_of_primary.logical_x, -1280.0);

        let got = to_physical(rect(10.0, 10.0, 100.0, 100.0), &left_of_primary).expect("rect");
        assert_eq!(
            got,
            PhysicalRect {
                x: 20,
                y: 20,
                width: 200,
                height: 200
            }
        );
    }

    #[test]
    fn a_negative_origin_monitor_still_owns_its_own_points() {
        let left_of_primary = MonitorBounds::from_physical(-2560, -300, 2560, 1440, 2.0);

        // Logical span is x ∈ [-1280, 0), y ∈ [-150, 570).
        assert!(left_of_primary.contains_global(-1280.0, -150.0));
        assert!(left_of_primary.contains_global(-1.0, 569.0));
        assert!(!left_of_primary.contains_global(0.0, 0.0), "that is the primary");
        assert!(!left_of_primary.contains_global(-1281.0, 0.0));

        assert_eq!(left_of_primary.global_to_local(-1000.0, 0.0), (280.0, 150.0));
    }

    #[test]
    fn a_drag_back_towards_the_origin_is_the_same_rectangle() {
        let forwards = to_physical(rect(100.0, 100.0, 200.0, 150.0), &monitor(1.0));
        let backwards = to_physical(rect(300.0, 250.0, -200.0, -150.0), &monitor(1.0));
        assert_eq!(forwards, backwards);
    }

    #[test]
    fn a_selection_dragged_off_screen_is_clamped_to_the_frame() {
        let got = to_physical(rect(-50.0, -50.0, 5000.0, 5000.0), &monitor(1.0)).expect("rect");
        assert_eq!(
            got,
            PhysicalRect {
                x: 0,
                y: 0,
                width: 1920,
                height: 1080
            }
        );
    }

    #[test]
    fn an_empty_selection_is_not_an_image() {
        assert_eq!(to_physical(rect(10.0, 10.0, 0.0, 100.0), &monitor(1.0)), None);
        // Entirely off-screen to the left.
        assert_eq!(
            to_physical(rect(-500.0, 10.0, 200.0, 100.0), &monitor(1.0)),
            None
        );
    }

    /// macOS reports logical bounds, Windows reports physical ones. Both constructors must
    /// describe the same 2x 1512-point display.
    #[test]
    fn the_two_constructors_agree_on_a_retina_display() {
        let from_macos = MonitorBounds::from_logical(0, 0, 1512, 982, 2.0);
        let from_windows = MonitorBounds::from_physical(0, 0, 3024, 1964, 2.0);
        assert_eq!(from_macos, from_windows);
    }

    #[test]
    fn full_frame_is_the_whole_physical_monitor() {
        assert_eq!(
            monitor(1.5).full_frame(),
            PhysicalRect {
                x: 0,
                y: 0,
                width: 2880,
                height: 1620
            }
        );
    }
}
