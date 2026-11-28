"""Render the per-page link-preview cards.

    python3 marketing/tools/render-og-cards.py            # all cards
    python3 marketing/tools/render-og-cards.py <slug> ... # some cards

Reads og-cards.json, fills og-page-card.html, screenshots at 1200x630 with
deviceScaleFactor 2, downscales to 1200x630 and saves a 256-colour PNG in marketing/site/og/<slug>.png.
Needs Playwright (Chromium) and Pillow.
"""
import io
import json
import pathlib
import sys

from PIL import Image
from playwright.sync_api import sync_playwright

TOOLS = pathlib.Path(__file__).resolve().parent
OUT = TOOLS.parent / "site" / "og"


def main(slugs):
    cards = json.loads((TOOLS / "og-cards.json").read_text())
    OUT.mkdir(exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1200, "height": 630}, device_scale_factor=2)
        for slug in slugs or cards:
            card = cards[slug]
            page.goto((TOOLS / "og-page-card.html").as_uri())
            # load every Inter weight before render() measures the headline
            page.evaluate("Promise.all([400, 600, 700, 800].map(w => document.fonts.load(w + ' 20px Inter')))")
            size = page.evaluate("c => render(c)", card)
            page.evaluate("document.fonts.ready")
            png = page.screenshot(clip={"x": 0, "y": 0, "width": 1200, "height": 630})
            img = Image.open(io.BytesIO(png)).convert("RGB").resize((1200, 630), Image.LANCZOS)
            # 256-colour palette: about half the size, no visible change on these flat cards
            img = img.quantize(colors=256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
            target = OUT / f"{slug}.png"
            img.save(target, optimize=True)
            print(f"{target.relative_to(TOOLS.parent.parent)}  headline {size}px  {target.stat().st_size // 1024} KB")
        browser.close()


if __name__ == "__main__":
    main(sys.argv[1:])
