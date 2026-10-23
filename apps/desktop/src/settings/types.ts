export type Tab = "general" | "shelf" | "devices" | "license" | "privacy" | "about";

/** Mirrors `settings::Settings` (serde camelCase). */
export type AppSettings = {
  captureHotkey: string;
  shelfHotkey: string;
  fullScreenHotkey: string | null;
  copyOnCapture: boolean;
  showShelfOnCapture: boolean;
  itemTtl: string;
  shelfSide: "left" | "right";
  /** `null` is "never" (PRD F2.2). */
  autoHideSeconds: number | null;
  removeAfterDrag: boolean;
  theme: "system" | "light" | "dark";
  catchOtherScreenshots: boolean;
  /** PRD F4.3 — upload every new capture to the paired phones. */
  autoSync: boolean;
};

/** Mirrors `hotkeys::Conflict` — a shortcut Hopshot asked for and did not get (PRD F1.1). */
export type HotkeyConflict = {
  action: string;
  settingKey: string;
  accelerator: string;
  message: string;
};

/** Mirrors `commands::PlanStatus`. */
export type PlanStatus = {
  plan: "expired" | "trial" | "lifetime" | "sync";
  includesSync: boolean;
  shelfCapacity: number;
  itemTtlOptions: string[];
};
