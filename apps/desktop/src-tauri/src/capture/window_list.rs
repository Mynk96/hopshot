//! Window capture (PRD F1.6): which windows the overlay can highlight on each monitor.
//!
//! ```text
//! capture::start ─▶ snapshot() ─▶ platform::list_windows()   front-to-back, global coords
//!                             ─▶ keep()                       filter, no OS calls
//!                             ─▶ rects_for(bounds)            per monitor: to_local + clip
//! ```
//!
//! Everything below `platform::list_windows` is plain data so it is tested on every OS.
//! Window titles and app names are never read here: the overlay only ever gets rectangles
//! (docs/designs/cleanshot-gaps.md, "Security / privacy").

use std::time::Instant;

use thiserror::Error;

use crate::capture::crop::{LogicalRect, MonitorBounds};
use crate::platform;

/// Smaller than this (in logical px, after clipping to the monitor) is not worth a
/// highlight: it is a sliver of a window on the next monitor, or an invisible helper.
pub const MIN_SIDE: f64 = 24.0;

#[derive(Debug, Error)]
pub enum WindowListError {
    #[error("the window list could not be read: {0}")]
    List(String),
}

/// The coordinate space a platform reports window bounds in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Space {
    /// macOS `kCGWindowBounds`: global points, top-left origin, the same space as
    /// `MonitorBounds::logical_*`.
    Logical,
    /// Windows `DWMWA_EXTENDED_FRAME_BOUNDS`: physical virtual-desktop pixels.
    Physical,
}

/// One on-screen window as the platform reported it. Fields a platform cannot know are left
/// at their neutral value (`layer` 0 and `alpha` 1 on Windows; no class name on macOS).
#[derive(Debug, Clone, PartialEq)]
pub struct WindowInfo {
    pub pid: u32,
    /// macOS window layer; 0 is ordinary app windows. Menu bar, Dock and floating palettes
    /// sit above 0.
    pub layer: i64,
    pub alpha: f64,
    pub minimized: bool,
    /// Windows class name, for the shell windows xcap keeps.
    pub class_name: Option<String>,
    /// `WS_EX_TOOLWINDOW` on Windows.
    pub tool_window: bool,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Windows shell surfaces that look like windows but are part of the desktop.
const SHELL_CLASSES: [&str; 3] = ["Shell_TrayWnd", "Shell_SecondaryTrayWnd", "WorkerW"];

/// Whether a window can be highlighted. Pure, so both platforms' rules run in every test run.
pub fn keep(window: &WindowInfo, own_pid: u32) -> bool {
    if window.pid == own_pid || window.minimized || window.tool_window {
        return false;
    }
    if window.layer != 0 || window.alpha <= 0.0 {
        return false;
    }
    if let Some(class) = &window.class_name {
        if SHELL_CLASSES.contains(&class.as_str()) {
            return false;
        }
    }
    window.width > 0.0 && window.height > 0.0
}

/// One window's rectangle in this monitor's overlay (CSS px, monitor-local), clipped to the
/// monitor. `None` when it is off this monitor or too small once clipped.
pub fn to_local(window: &WindowInfo, space: Space, bounds: &MonitorBounds) -> Option<LogicalRect> {
    let (left, top, right, bottom) = match space {
        Space::Logical => (
            window.x - bounds.logical_x,
            window.y - bounds.logical_y,
            window.x + window.width - bounds.logical_x,
            window.y + window.height - bounds.logical_y,
        ),
        Space::Physical => {
            let scale = bounds.scale_factor;
            // Exact: `logical_x` is the unrounded `x / scale` from `MonitorBounds::from_physical`.
            let origin_x = bounds.logical_x * scale;
            let origin_y = bounds.logical_y * scale;
            (
                (window.x - origin_x) / scale,
                (window.y - origin_y) / scale,
                (window.x + window.width - origin_x) / scale,
                (window.y + window.height - origin_y) / scale,
            )
        }
    };

    let left = left.clamp(0.0, bounds.logical_width);
    let top = top.clamp(0.0, bounds.logical_height);
    let right = right.clamp(0.0, bounds.logical_width);
    let bottom = bottom.clamp(0.0, bounds.logical_height);

    let width = right - left;
    let height = bottom - top;
    if width < MIN_SIDE || height < MIN_SIDE {
        return None;
    }

    Some(LogicalRect {
        x: left,
        y: top,
        width,
        height,
    })
}

/// The highlightable windows on one monitor, front-to-back, from an already-filtered list.
pub fn rects_for(windows: &[WindowInfo], space: Space, bounds: &MonitorBounds) -> Vec<LogicalRect> {
    windows
        .iter()
        .filter_map(|window| to_local(window, space, bounds))
        .collect()
}

/// List and filter the on-screen windows, front-to-back.
///
/// Never fails the capture: region capture must not depend on this, so an error is logged
/// and the overlay simply has no windows to offer (window mode says so).
pub fn snapshot() -> Vec<WindowInfo> {
    let started = Instant::now();
    let own_pid = std::process::id();

    let windows = match platform::list_windows() {
        Ok(listed) => listed
            .into_iter()
            .filter(|window| keep(window, own_pid))
            .collect::<Vec<_>>(),
        Err(error) => {
            log::warn!("window capture unavailable for this capture: {error}");
            Vec::new()
        }
    };

    log::info!(
        "listed {} window(s) in {:.1} ms",
        windows.len(),
        started.elapsed().as_secs_f64() * 1000.0
    );
    windows
}

#[cfg(test)]
mod tests {
    use super::*;

    fn window(x: f64, y: f64, width: f64, height: f64) -> WindowInfo {
        WindowInfo {
            pid: 42,
            layer: 0,
            alpha: 1.0,
            minimized: false,
            class_name: None,
            tool_window: false,
            x,
            y,
            width,
            height,
        }
    }

    fn rect(x: f64, y: f64, width: f64, height: f64) -> LogicalRect {
        LogicalRect {
            x,
            y,
            width,
            height,
        }
    }

    fn close(a: LogicalRect, b: LogicalRect) {
        let near = |p: f64, q: f64| (p - q).abs() < 1e-9;
        assert!(
            near(a.x, b.x) && near(a.y, b.y) && near(a.width, b.width) && near(a.height, b.height),
            "{a:?} != {b:?}"
        );
    }

    // ---- to_local, macOS (points) ----

    #[test]
    fn mac_points_map_straight_to_the_overlay_at_1x_and_2x() {
        for scale in [1.0, 2.0] {
            let bounds = MonitorBounds::from_logical(0, 0, 1440, 900, scale);
            let local = to_local(&window(100.0, 50.0, 800.0, 600.0), Space::Logical, &bounds);
            close(local.expect("on screen"), rect(100.0, 50.0, 800.0, 600.0));
        }
    }

    #[test]
    fn mac_monitor_with_a_negative_origin_subtracts_its_origin() {
        // An external display left of and above the built-in one.
        let bounds = MonitorBounds::from_logical(-1920, -200, 1920, 1080, 1.0);
        let local = to_local(
            &window(-1820.0, -100.0, 400.0, 300.0),
            Space::Logical,
            &bounds,
        );
        close(local.expect("on screen"), rect(100.0, 100.0, 400.0, 300.0));
    }

    // ---- to_local, Windows (physical) ----

    #[test]
    fn windows_physical_bounds_divide_by_the_monitor_scale() {
        for scale in [1.0, 1.25, 1.5, 2.0] {
            let bounds = MonitorBounds::from_physical(0, 0, 3840, 2160, scale);
            let local = to_local(
                &window(200.0 * scale, 100.0 * scale, 600.0 * scale, 400.0 * scale),
                Space::Physical,
                &bounds,
            );
            close(local.expect("on screen"), rect(200.0, 100.0, 600.0, 400.0));
        }
    }

    #[test]
    fn windows_monitor_left_of_the_primary_has_a_negative_x() {
        // 1920 px wide at 125%, sitting left of the primary monitor.
        let bounds = MonitorBounds::from_physical(-1920, 0, 1920, 1080, 1.25);
        let local = to_local(
            &window(-1795.0, 125.0, 500.0, 250.0),
            Space::Physical,
            &bounds,
        );
        close(local.expect("on screen"), rect(100.0, 100.0, 400.0, 200.0));
    }

    // ---- clipping ----

    #[test]
    fn a_window_across_two_monitors_is_clipped_on_each() {
        let left = MonitorBounds::from_logical(0, 0, 1000, 800, 1.0);
        let right = MonitorBounds::from_logical(1000, 0, 1000, 800, 1.0);
        let spanning = window(900.0, 100.0, 300.0, 200.0);

        close(
            to_local(&spanning, Space::Logical, &left).expect("left part"),
            rect(900.0, 100.0, 100.0, 200.0),
        );
        close(
            to_local(&spanning, Space::Logical, &right).expect("right part"),
            rect(0.0, 100.0, 200.0, 200.0),
        );
    }

    #[test]
    fn a_sliver_left_after_clipping_is_dropped() {
        let bounds = MonitorBounds::from_logical(0, 0, 1000, 800, 1.0);
        // Only 20 px of this window reach the monitor.
        assert_eq!(
            to_local(&window(980.0, 100.0, 400.0, 300.0), Space::Logical, &bounds),
            None
        );
    }

    #[test]
    fn a_window_on_another_monitor_is_not_offered() {
        let bounds = MonitorBounds::from_logical(0, 0, 1000, 800, 1.0);
        assert_eq!(
            to_local(
                &window(1200.0, 100.0, 400.0, 300.0),
                Space::Logical,
                &bounds
            ),
            None
        );
    }

    // ---- filtering ----

    #[test]
    fn ordinary_windows_are_kept() {
        assert!(keep(&window(0.0, 0.0, 400.0, 300.0), 1));
    }

    #[test]
    fn hopshot_s_own_windows_are_never_offered() {
        assert!(!keep(&window(0.0, 0.0, 400.0, 300.0), 42));
    }

    #[test]
    fn minimized_and_tool_windows_are_dropped() {
        let mut minimized = window(0.0, 0.0, 400.0, 300.0);
        minimized.minimized = true;
        assert!(!keep(&minimized, 1));

        let mut tool = window(0.0, 0.0, 400.0, 300.0);
        tool.tool_window = true;
        assert!(!keep(&tool, 1));
    }

    #[test]
    fn mac_menu_bar_dock_and_invisible_windows_are_dropped() {
        let mut menu_bar = window(0.0, 0.0, 1440.0, 24.0);
        menu_bar.layer = 24;
        assert!(!keep(&menu_bar, 1));

        let mut invisible = window(0.0, 0.0, 400.0, 300.0);
        invisible.alpha = 0.0;
        assert!(!keep(&invisible, 1));
    }

    #[test]
    fn windows_taskbars_and_the_desktop_worker_are_dropped() {
        for class in ["Shell_TrayWnd", "Shell_SecondaryTrayWnd", "WorkerW"] {
            let mut shell = window(0.0, 1040.0, 1920.0, 40.0);
            shell.class_name = Some(class.to_string());
            assert!(!keep(&shell, 1), "{class}");
        }

        let mut chrome = window(0.0, 0.0, 1200.0, 800.0);
        chrome.class_name = Some("Chrome_WidgetWin_1".to_string());
        assert!(keep(&chrome, 1));
    }

    #[test]
    fn front_to_back_order_survives_filtering_and_clipping() {
        let bounds = MonitorBounds::from_logical(0, 0, 1000, 800, 1.0);
        let windows = vec![
            window(10.0, 10.0, 100.0, 100.0),  // front
            window(2000.0, 0.0, 100.0, 100.0), // other monitor, dropped
            window(50.0, 50.0, 500.0, 500.0),  // behind
        ];
        let rects = rects_for(&windows, Space::Logical, &bounds);
        assert_eq!(rects.len(), 2);
        close(rects[0], rect(10.0, 10.0, 100.0, 100.0));
        close(rects[1], rect(50.0, 50.0, 500.0, 500.0));
    }
}
