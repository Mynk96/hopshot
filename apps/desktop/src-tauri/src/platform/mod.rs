//! Platform-specific code lives behind these modules and must compile for both targets
//! (CLAUDE.md rule 4).
//!
//! Each module exposes the same small surface, re-exported here, so the rest of the app
//! calls `platform::…` and never writes `#[cfg(target_os = …)]` of its own.

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub use macos::*;

#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "windows")]
pub use windows::*;

// Without this, a build on any other OS fails deep inside lib.rs with a pile of
// "cannot find function" errors instead of saying what is actually wrong.
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
compile_error!("Hopshot targets macOS and Windows only (PRD §3.3 non-goals).");
