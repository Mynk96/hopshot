//! The background tool's renderer (docs/designs/next-features.md, 0.1.16).
//!
//! A pure function from (screenshot, style) to a framed PNG-ready image: padding, a solid or
//! gradient fill, rounded corners and a soft shadow. No window, store or file access, so the
//! output is unit-tested on every OS and the preview and the saved file come from the same
//! code.
//!
//! Plain `image` buffers rather than a 2D canvas crate: the four operations needed here
//! (rounded-rect coverage, a two-stop gradient, a blurred shadow, alpha-over) are a few
//! dozen lines each, and a new dependency would buy nothing the tests don't already cover
//! (CLAUDE.md rule 5).

use image::{Rgba, RgbaImage};
use serde::{Deserialize, Serialize};

/// What goes behind the screenshot. Colours are DESIGN.md §2.4 "Background fills".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Fill {
    /// Transparent: padding and shadow only.
    None,
    Mist,
    Sand,
    Sage,
    Sky,
    /// The one gradient, in the brand orange.
    Sunset,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Padding {
    S,
    M,
    L,
}

/// The output's shape. Never crops: the canvas only ever grows to reach the ratio.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Aspect {
    /// The screenshot plus even padding on every side.
    #[serde(rename = "auto")]
    Auto,
    #[serde(rename = "16:9")]
    Wide,
    #[serde(rename = "1:1")]
    Square,
}

/// A background choice, as the panel edits it and `items.style` stores it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Style {
    pub fill: Fill,
    pub padding: Padding,
    /// Corner radius in display px, 0–24 (wireframe). Scaled with the image, see [`unit`].
    pub radius: u8,
    pub shadow: bool,
    pub aspect: Aspect,
}

/// The panel's maximum corner radius.
pub const MAX_RADIUS: u8 = 24;

impl Default for Style {
    /// What the panel opens with before the user has ever chosen.
    fn default() -> Self {
        Style {
            fill: Fill::Sunset,
            padding: Padding::M,
            radius: 12,
            shadow: true,
            aspect: Aspect::Auto,
        }
    }
}

impl Style {
    /// A stored or UI-supplied style with its radius kept in range.
    pub fn clamped(self) -> Self {
        Style {
            radius: self.radius.min(MAX_RADIUS),
            ..self
        }
    }
}

/// Shadow: black at this opacity, matching DESIGN §2.3's floating shadow.
const SHADOW_ALPHA: f32 = 0.35;
/// Shadow blur and drop, in display px (multiplied by [`unit`]).
const SHADOW_BLUR: f32 = 20.0;
const SHADOW_DROP: f32 = 8.0;
/// The shadow is blurred at this fraction of full size; it is soft, so nothing is lost and
/// a 4K capture blurs in a few ms instead of a few hundred.
const SHADOW_DOWNSCALE: u32 = 4;

/// How many image pixels one "display px" of radius, blur or minimum padding is.
///
/// Screenshots are physical pixels and the item keeps no scale factor, so this is inferred
/// from size: a typical 1x window shot is under 1,200 px wide, a Retina one about twice
/// that. Clamped so a tiny crop still gets visible corners and a huge one isn't absurd.
fn unit(width: u32, height: u32) -> f32 {
    (width.max(height) as f32 / 1200.0).clamp(1.0, 3.0)
}

/// Where everything goes, in output pixels.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Layout {
    pub canvas_width: u32,
    pub canvas_height: u32,
    pub image_x: u32,
    pub image_y: u32,
    pub radius: f32,
    pub blur: f32,
    pub drop: f32,
}

/// The layout for a `width`×`height` screenshot.
pub fn layout(width: u32, height: u32, style: &Style) -> Layout {
    let style = style.clamped();
    let u = unit(width, height);
    let longest = width.max(height) as f32;

    let fraction = match style.padding {
        Padding::S => 0.04,
        Padding::M => 0.07,
        Padding::L => 0.10,
    };
    let minimum = match style.padding {
        Padding::S => 16.0,
        Padding::M => 32.0,
        Padding::L => 48.0,
    } * u;
    let pad = (longest * fraction).max(minimum).round() as u32;

    let mut canvas_width = width + 2 * pad;
    let mut canvas_height = height + 2 * pad;

    let ratio = match style.aspect {
        Aspect::Auto => None,
        Aspect::Wide => Some((16u64, 9u64)),
        Aspect::Square => Some((1, 1)),
    };
    if let Some((rw, rh)) = ratio {
        // Grow whichever side is short of the ratio, never shrink: the screenshot is never
        // cropped to fit a shape.
        let (w, h) = (canvas_width as u64, canvas_height as u64);
        if w * rh < h * rw {
            canvas_width = (h * rw).div_ceil(rh) as u32;
        } else {
            canvas_height = (w * rh).div_ceil(rw) as u32;
        }
    }

    Layout {
        canvas_width,
        canvas_height,
        image_x: (canvas_width - width) / 2,
        image_y: (canvas_height - height) / 2,
        radius: (style.radius as f32 * u).min(width.min(height) as f32 / 2.0),
        blur: if style.shadow { SHADOW_BLUR * u } else { 0.0 },
        drop: if style.shadow { SHADOW_DROP * u } else { 0.0 },
    }
}

/// Frame a screenshot.
pub fn render(source: &RgbaImage, style: &Style) -> RgbaImage {
    render_scaled(source, style, source.width(), source.height())
}

/// Frame a downscaled copy so it looks exactly like the full-size result at its own size.
///
/// The preview is rendered from a smaller copy of the original, but padding minimums, the
/// radius and the shadow are sized from the *full* image, so the geometry is worked out at
/// full size and scaled down rather than recomputed for the small copy.
pub fn render_scaled(source: &RgbaImage, style: &Style, full_width: u32, full_height: u32) -> RgbaImage {
    let full = layout(full_width, full_height, style);
    let k = source.width() as f32 / full_width.max(1) as f32;

    let canvas_width = ((full.canvas_width as f32 * k).round() as u32).max(source.width());
    let canvas_height = ((full.canvas_height as f32 * k).round() as u32).max(source.height());
    let image_x = (canvas_width - source.width()) / 2;
    let image_y = (canvas_height - source.height()) / 2;
    let radius = full.radius * k;

    let mut canvas = RgbaImage::new(canvas_width, canvas_height);
    paint_fill(&mut canvas, style.fill);

    if style.shadow {
        let mask = shadow_mask(
            canvas_width,
            canvas_height,
            image_x as f32,
            image_y as f32 + full.drop * k,
            source.width() as f32,
            source.height() as f32,
            radius,
            full.blur * k,
        );
        composite_shadow(&mut canvas, &mask);
    }

    for y in 0..source.height() {
        for x in 0..source.width() {
            let coverage = rounded_coverage(
                x as f32 + 0.5,
                y as f32 + 0.5,
                source.width() as f32,
                source.height() as f32,
                radius,
            );
            if coverage <= 0.0 {
                continue;
            }
            let mut pixel = *source.get_pixel(x, y);
            pixel[3] = (pixel[3] as f32 * coverage).round() as u8;
            let target = canvas.get_pixel_mut(x + image_x, y + image_y);
            *target = over(pixel, *target);
        }
    }

    canvas
}

/// DESIGN.md §2.4 "Background fills".
fn paint_fill(canvas: &mut RgbaImage, fill: Fill) {
    let solid = |hex: u32| {
        Rgba([(hex >> 16) as u8, (hex >> 8) as u8, hex as u8, 255])
    };
    match fill {
        Fill::None => {}
        Fill::Mist => fill_solid(canvas, solid(0xE4E7EC)),
        Fill::Sand => fill_solid(canvas, solid(0xEFE4D6)),
        Fill::Sage => fill_solid(canvas, solid(0xDCE8DE)),
        Fill::Sky => fill_solid(canvas, solid(0xDAE6F4)),
        Fill::Sunset => {
            // Top-left to bottom-right, brand orange into a warm pink.
            let (from, to) = (solid(0xFF8A3D), solid(0xFF5E7A));
            let (w, h) = (canvas.width().max(1) as f32, canvas.height().max(1) as f32);
            let span = w + h;
            for (x, y, pixel) in canvas.enumerate_pixels_mut() {
                let t = (x as f32 + y as f32) / span;
                *pixel = lerp(from, to, t);
            }
        }
    }
}

fn fill_solid(canvas: &mut RgbaImage, color: Rgba<u8>) {
    for pixel in canvas.pixels_mut() {
        *pixel = color;
    }
}

fn lerp(a: Rgba<u8>, b: Rgba<u8>, t: f32) -> Rgba<u8> {
    let mix = |i: usize| (a[i] as f32 + (b[i] as f32 - a[i] as f32) * t).round() as u8;
    Rgba([mix(0), mix(1), mix(2), mix(3)])
}

/// How much of the pixel centred at (`px`, `py`) is inside a `w`×`h` rounded rectangle at
/// the origin, 0–1, antialiased over one pixel at the corners.
fn rounded_coverage(px: f32, py: f32, w: f32, h: f32, radius: f32) -> f32 {
    if px < 0.0 || py < 0.0 || px > w || py > h {
        return 0.0;
    }
    if radius <= 0.0 {
        return 1.0;
    }
    let cx = if px < radius {
        radius
    } else if px > w - radius {
        w - radius
    } else {
        return 1.0;
    };
    let cy = if py < radius {
        radius
    } else if py > h - radius {
        h - radius
    } else {
        return 1.0;
    };
    let distance = ((px - cx).powi(2) + (py - cy).powi(2)).sqrt();
    (radius - distance + 0.5).clamp(0.0, 1.0)
}

/// A downscaled, blurred alpha mask of the screenshot's rounded rectangle.
struct Mask {
    width: u32,
    height: u32,
    values: Vec<f32>,
}

impl Mask {
    /// Bilinear sample at canvas coordinates.
    fn sample(&self, x: f32, y: f32) -> f32 {
        let s = SHADOW_DOWNSCALE as f32;
        let fx = (x / s - 0.5).max(0.0);
        let fy = (y / s - 0.5).max(0.0);
        let x0 = (fx.floor() as u32).min(self.width - 1);
        let y0 = (fy.floor() as u32).min(self.height - 1);
        let x1 = (x0 + 1).min(self.width - 1);
        let y1 = (y0 + 1).min(self.height - 1);
        let tx = fx - x0 as f32;
        let ty = fy - y0 as f32;
        let at = |x: u32, y: u32| self.values[(y * self.width + x) as usize];
        let top = at(x0, y0) + (at(x1, y0) - at(x0, y0)) * tx;
        let bottom = at(x0, y1) + (at(x1, y1) - at(x0, y1)) * tx;
        top + (bottom - top) * ty
    }
}

#[allow(clippy::too_many_arguments)]
fn shadow_mask(
    canvas_width: u32,
    canvas_height: u32,
    x: f32,
    y: f32,
    w: f32,
    h: f32,
    radius: f32,
    blur: f32,
) -> Mask {
    let s = SHADOW_DOWNSCALE as f32;
    let width = canvas_width.div_ceil(SHADOW_DOWNSCALE).max(1);
    let height = canvas_height.div_ceil(SHADOW_DOWNSCALE).max(1);
    let mut values = vec![0.0f32; (width * height) as usize];

    for my in 0..height {
        for mx in 0..width {
            let cx = (mx as f32 + 0.5) * s - x;
            let cy = (my as f32 + 0.5) * s - y;
            values[(my * width + mx) as usize] = rounded_coverage(cx, cy, w, h, radius);
        }
    }

    // Three box passes approximate a Gaussian; the radius is split so the total spread is
    // about `blur` canvas px.
    let box_radius = ((blur / s) / 3.0).round() as usize;
    for _ in 0..3 {
        box_blur(&mut values, width as usize, height as usize, box_radius);
    }

    Mask { width, height, values }
}

/// One horizontal and one vertical box-blur pass, in place, with edge clamping.
fn box_blur(values: &mut [f32], width: usize, height: usize, radius: usize) {
    if radius == 0 {
        return;
    }
    let mut line = vec![0.0f32; width.max(height)];
    let window = (2 * radius + 1) as f32;

    for y in 0..height {
        let row = &mut values[y * width..(y + 1) * width];
        line[..width].copy_from_slice(row);
        let at = |i: isize| line[i.clamp(0, width as isize - 1) as usize];
        let mut sum: f32 = (-(radius as isize)..=radius as isize).map(at).sum();
        for (x, out) in row.iter_mut().enumerate() {
            *out = sum / window;
            sum += at(x as isize + radius as isize + 1) - at(x as isize - radius as isize);
        }
    }

    for x in 0..width {
        for y in 0..height {
            line[y] = values[y * width + x];
        }
        let at = |i: isize| line[i.clamp(0, height as isize - 1) as usize];
        let mut sum: f32 = (-(radius as isize)..=radius as isize).map(at).sum();
        for y in 0..height {
            values[y * width + x] = sum / window;
            sum += at(y as isize + radius as isize + 1) - at(y as isize - radius as isize);
        }
    }
}

fn composite_shadow(canvas: &mut RgbaImage, mask: &Mask) {
    for (x, y, pixel) in canvas.enumerate_pixels_mut() {
        let alpha = mask.sample(x as f32 + 0.5, y as f32 + 0.5) * SHADOW_ALPHA;
        if alpha <= 0.002 {
            continue;
        }
        let shade = Rgba([0, 0, 0, (alpha * 255.0).round() as u8]);
        *pixel = over(shade, *pixel);
    }
}

/// Straight-alpha "source over destination".
fn over(src: Rgba<u8>, dst: Rgba<u8>) -> Rgba<u8> {
    let sa = src[3] as f32 / 255.0;
    if sa >= 1.0 {
        return src;
    }
    if sa <= 0.0 {
        return dst;
    }
    let da = dst[3] as f32 / 255.0;
    let out_a = sa + da * (1.0 - sa);
    if out_a <= 0.0 {
        return Rgba([0, 0, 0, 0]);
    }
    let channel = |i: usize| {
        ((src[i] as f32 * sa + dst[i] as f32 * da * (1.0 - sa)) / out_a).round() as u8
    };
    Rgba([channel(0), channel(1), channel(2), (out_a * 255.0).round() as u8])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn white(width: u32, height: u32) -> RgbaImage {
        RgbaImage::from_pixel(width, height, Rgba([255, 255, 255, 255]))
    }

    fn plain(fill: Fill) -> Style {
        Style {
            fill,
            padding: Padding::M,
            radius: 0,
            shadow: false,
            aspect: Aspect::Auto,
        }
    }

    #[test]
    fn auto_adds_even_padding_and_centres_the_image() {
        let l = layout(1000, 500, &plain(Fill::Mist));
        // M is 7% of the longest side, above its 32 px minimum.
        assert_eq!(l.image_x, 70);
        assert_eq!(l.image_y, 70);
        assert_eq!((l.canvas_width, l.canvas_height), (1140, 640));
    }

    #[test]
    fn small_images_get_the_minimum_padding() {
        let l = layout(200, 100, &Style { padding: Padding::L, ..plain(Fill::Mist) });
        assert_eq!(l.image_x, 48);
        assert_eq!((l.canvas_width, l.canvas_height), (296, 196));
    }

    #[test]
    fn padding_grows_with_size() {
        let s = layout(1000, 500, &Style { padding: Padding::S, ..plain(Fill::Mist) });
        let m = layout(1000, 500, &Style { padding: Padding::M, ..plain(Fill::Mist) });
        let l = layout(1000, 500, &Style { padding: Padding::L, ..plain(Fill::Mist) });
        assert!(s.image_x < m.image_x && m.image_x < l.image_x);
    }

    #[test]
    fn wide_and_square_grow_the_canvas_and_never_crop() {
        for (w, h) in [(1000, 500), (400, 900), (300, 300)] {
            let wide = layout(w, h, &Style { aspect: Aspect::Wide, ..plain(Fill::Mist) });
            assert!(wide.canvas_width * 9 >= wide.canvas_height * 16 - 16, "{w}x{h}");
            assert!(wide.canvas_width * 9 <= wide.canvas_height * 16 + 16, "{w}x{h}");
            assert!(wide.canvas_width >= w && wide.canvas_height >= h);

            let square = layout(w, h, &Style { aspect: Aspect::Square, ..plain(Fill::Mist) });
            assert_eq!(square.canvas_width, square.canvas_height, "{w}x{h}");
            assert!(square.canvas_width >= w.max(h));
        }
    }

    #[test]
    fn the_radius_is_clamped_to_the_panel_maximum() {
        let style = Style { radius: 200, ..Style::default() }.clamped();
        assert_eq!(style.radius, MAX_RADIUS);
    }

    #[test]
    fn the_output_has_the_layout_s_size_and_keeps_the_screenshot() {
        let source = white(300, 200);
        let style = plain(Fill::Sage);
        let out = render(&source, &style);
        let l = layout(300, 200, &style);
        assert_eq!((out.width(), out.height()), (l.canvas_width, l.canvas_height));
        // Centre of the screenshot is the screenshot; a corner of the canvas is the fill.
        assert_eq!(*out.get_pixel(l.image_x + 150, l.image_y + 100), Rgba([255, 255, 255, 255]));
        assert_eq!(*out.get_pixel(0, 0), Rgba([0xDC, 0xE8, 0xDE, 255]));
    }

    #[test]
    fn no_fill_leaves_the_padding_transparent() {
        let out = render(&white(100, 100), &plain(Fill::None));
        assert_eq!(out.get_pixel(0, 0)[3], 0);
    }

    #[test]
    fn rounded_corners_cut_the_corner_pixels() {
        let source = white(400, 300);
        let style = Style { radius: 24, ..plain(Fill::None) };
        let out = render(&source, &style);
        let l = layout(400, 300, &style);
        // The screenshot's own top-left pixel is outside the curve, its middle is not.
        assert_eq!(out.get_pixel(l.image_x, l.image_y)[3], 0);
        assert_eq!(out.get_pixel(l.image_x + 200, l.image_y)[3], 255);
    }

    #[test]
    fn the_shadow_darkens_below_the_screenshot_more_than_above() {
        let source = white(400, 300);
        let style = Style { shadow: true, ..plain(Fill::Mist) };
        let out = render(&source, &style);
        let l = layout(400, 300, &style);
        let below = out.get_pixel(l.image_x + 200, l.image_y + 300 + 6)[0];
        let above = out.get_pixel(l.image_x + 200, l.image_y - 6)[0];
        assert!(below < above, "below {below}, above {above}");
        assert!(below < 0xE4, "the shadow should darken the fill");
    }

    #[test]
    fn the_gradient_runs_from_orange_to_pink() {
        let out = render(&white(100, 100), &plain(Fill::Sunset));
        let first = *out.get_pixel(0, 0);
        let last = *out.get_pixel(out.width() - 1, out.height() - 1);
        assert_eq!(first[0], 0xFF);
        assert!(first[1] > last[1], "green falls from orange to pink");
        assert!(first[2] < last[2], "blue rises toward pink");
    }

    #[test]
    fn a_scaled_preview_has_the_full_render_s_proportions() {
        let style = Style::default();
        let full = render(&white(1200, 800), &style);
        let preview = render_scaled(&white(600, 400), &style, 1200, 800);
        let ratio = |img: &RgbaImage| img.width() as f32 / img.height() as f32;
        assert!((ratio(&full) - ratio(&preview)).abs() < 0.01);
        assert!((full.width() as f32 / 2.0 - preview.width() as f32).abs() <= 1.0);
    }

    #[test]
    fn rendering_is_deterministic() {
        // Crash recovery re-renders from the original and the stored style (design doc,
        // "Startup recovery"), which is only safe if the same input gives the same bytes.
        let source = white(320, 180);
        let style = Style::default();
        assert_eq!(render(&source, &style).as_raw(), render(&source, &style).as_raw());
    }

    #[test]
    fn styles_round_trip_through_json_with_the_ui_s_names() {
        let style = Style { aspect: Aspect::Wide, padding: Padding::L, ..Style::default() };
        let json = serde_json::to_value(style).expect("serialize");
        assert_eq!(json["aspect"], "16:9");
        assert_eq!(json["padding"], "l");
        assert_eq!(json["fill"], "sunset");
        let back: Style = serde_json::from_value(json).expect("parse");
        assert_eq!(back, style);
    }
}
