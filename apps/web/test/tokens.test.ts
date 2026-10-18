import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { limits, SITE_URL } from "shared";

// Phase 8 adds Playwright for the viewer/pair flows (ARCHITECTURE §10).
describe("web app wiring", () => {
  it("shares the one tokens.css with the desktop app", () => {
    const css = readFileSync(
      fileURLToPath(new URL("../../../packages/shared/src/tokens.css", import.meta.url)),
      "utf8",
    );
    expect(css).toContain("--accent: #ff6b2c");
    expect(css).toContain("@theme inline");
  });

  it("reads plan limits from config/limits.json", () => {
    expect(limits.lifetime.shelfCapacity).toBe(100);
    expect(SITE_URL).toBe("https://hopshot.xyz");
  });
});
