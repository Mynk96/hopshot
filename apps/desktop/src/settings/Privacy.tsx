import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";
import { Group, Row } from "./controls";

/**
 * Settings → Privacy (DESIGN S7, PRD Settings).
 *
 * - Usage counts are always on (ARCHITECTURE §7.10, product decision 0.1.8), so they are
 *   explained here rather than given a switch that would not do anything.
 * - There is no crash reporting in Hopshot, so this says so instead of showing a toggle.
 * - "Delete all my cloud data" takes every send link offline and deletes the phone vault
 *   (`delete_cloud_data`); the shelf on this computer stays.
 */

type CloudDeletion = { links: number; vault: boolean };

type DeleteState =
  | { kind: "idle" }
  | { kind: "confirming" }
  | { kind: "deleting" }
  | { kind: "done"; result: CloudDeletion }
  | { kind: "failed"; message: string };

function summary({ links, vault }: CloudDeletion): string {
  if (links === 0 && !vault) return "Nothing was stored online.";
  const parts: string[] = [];
  if (links > 0) parts.push(links === 1 ? "1 share link" : `${links} share links`);
  if (vault) parts.push("everything synced to your phones");
  return `Deleted ${parts.join(" and ")}.`;
}

export function Privacy() {
  const [state, setState] = useState<DeleteState>({ kind: "idle" });

  const deleteAll = async () => {
    setState({ kind: "deleting" });
    try {
      const result = await invoke<CloudDeletion>("delete_cloud_data");
      setState({ kind: "done", result });
    } catch (reason) {
      setState({ kind: "failed", message: String(reason) });
    }
  };

  return (
    <section>
      <h3 className="mb-3 text-title">Privacy</h3>

      <Group>
        <Row
          label="Usage counts"
          hint="Once a day: a random install id, the app version, your OS and how many screenshots you took. Never images, file names or anything on your screen."
        >
          <span className="text-caption text-text-2">Always on</span>
        </Row>
        <Row label="Crash reports" hint="Hopshot doesn't send crash reports.">
          <span className="text-caption text-text-2">Off</span>
        </Row>
        <div className="py-2.5 text-caption text-text-2">
          Details: app.hopshot.xyz/privacy
        </div>
      </Group>

      <Group>
        <Row
          label="Delete all my cloud data"
          hint="Takes every share link offline and deletes everything synced to your phones, which unpairs them. Your shelf on this computer stays."
          problem={state.kind === "failed" ? state.message : undefined}
        >
          {(state.kind === "idle" || state.kind === "done" || state.kind === "failed") && (
            <button
              type="button"
              className="btn btn-danger-ghost btn-compact"
              onClick={() => setState({ kind: "confirming" })}
            >
              Delete…
            </button>
          )}
          {state.kind === "deleting" && (
            <span className="text-caption text-text-2">Deleting…</span>
          )}
        </Row>

        {state.kind === "confirming" && (
          <div className="flex flex-col gap-2 py-2.5" role="alertdialog" aria-label="Confirm delete">
            <p className="text-body">
              Delete everything Hopshot stored online? Your shelf on this computer stays.
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                className="btn btn-danger-ghost btn-compact"
                style={{ border: "1px solid var(--danger)" }}
                onClick={() => void deleteAll()}
              >
                Delete everything
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-compact"
                onClick={() => setState({ kind: "idle" })}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {state.kind === "done" && (
          <div className="py-2.5 text-caption text-text-2" role="status">
            {summary(state.result)}
          </div>
        )}
      </Group>
    </section>
  );
}
