# Agent-directed visual feedback v1

**Date:** 2026-11-26
**Status:** Implemented locally; the agent-request path is covered by focused tests, but no authentic person approval was available for a live end-to-end request. Historical comparison and Godot check history were exercised with real captures and a real Godot run.
**OhMyGame:** `ThorStarlord/ohmygame`, branch `feat/agent-directed-visual-feedback`, based on `dev` `51bf59cb30fb1644bb96bfdd45fe603bdaba4094`.

## Delivered

- `engine_capture_request` for the selected project's in-app coding agent. It names a managed native session, asks the person through the normal approval card for one still image, revalidates the session after approval, and returns the authorized image with its capture ID.
- The approval card shows the project, game session and requested permission in the app's language. It offers **Allow** once and **Deny**, never a remembered permission.
- A one-time request service bound to one project, session and root process. It is published only to that project's open desktop windows; one window claims it before capturing. Denial, cancellation, expiry, a stopped or replaced session, an ambiguous window or a late duplicate answer cannot produce an extra capture.
- Six recent captures per session and twelve per project, retaining exact capture IDs and provenance (`requestId`, plugin, session, dimensions, window ownership, blank-frame analysis). An evicted ID is reported as unavailable rather than silently replaced.
- `engine_capture` can read an exact `captureId` or a session's latest image. The project agent and external MCP clients keep read-only access; only the in-app conversation can initiate a request.
- Problems & engine status lists retained captures and offers a before/after selection with side-by-side images, metadata and a caution that a visible difference is evidence, not proof of improvement.
- Shared engine-check history now observes the official Godot `run_headless` (test) and `export_web` (export) tools. Godot `res://` error and warning lines are extracted with source locations. A Godot check that reports errors but exits 0 is marked as reporting errors; a thrown export with a named exit code is a failed export, while setup errors remain invocation failures.

## Verification

- `test/native-capture-requests.test.ts` — 5 passed: one claim/one answer, wrong project, denial, cancellation, project/session invalidation and unclaimed answers.
- `test/native-window-captures.test.ts` — 5 passed: exact retrieval, per-session history, eviction, metadata and payload/budget checks.
- `test/engine-check-history.test.ts` — 6 passed: Godot mapping, real parse-error shape, `res://` source extraction, false-source refusal, exit-0 reported errors and export failure classification.
- `test/approval-card.test.tsx` — native capture wording and only Allow/Deny.
- `test/agent-tools.test.ts` — exact capture retrieval and `engine_capture_request` image return.
- `test/app.test.ts` — 92 passed.
- Broader focused suite (preview, external MCP, Ren'Py plugin, native output, Godot plugin, extension hosts) — 144 passed, 4 skipped, with one unrelated extension-host activation test failing once under parallel load and passing alone.
- `typecheck`, `lint`, `plugin:check plugins/renpy`, `build:host` and `build:renderer` pass.

## Desktop comparison exercise

The built desktop app was launched with a temporary data directory and a disposable `renpy-pilot` project. Two existing real captures were loaded through the person-facing manual capture route **as comparison fixtures**:

- Ren'Py menu, 1920 x 1112, `likelyBlank: false`.
- Atlas title, 1920 x 1124, `likelyBlank: false`.

Problems & engine status showed both retained captures, both `View capture` actions returned the exact images, and the before/after selectors rendered them side by side with session, plugin and dimension metadata. The app was not asked to impersonate a person approving an agent request.

## Godot exercise

A disposable Atlas copy with its `.godot` class cache was run through the official Godot 4.7.2 plugin's `run_headless` tool:

- **Before:** a deliberate parse error in `res://tests/ohmygame_probe.gd:4`. Godot exited 0 but printed two error lines. Shared history recorded `status: failed`, `exitCode: 0`, `reportedErrors: true`, with source links to `tests/ohmygame_probe.gd:4`.
- **After:** the script was corrected and rerun. Shared history recorded `status: passed`, no diagnostics, and a comparison of `recurring: 0`, `newlyReported: 0`, `noLongerReported: 2`.

This is a real engine finding and correction through the shared extraction model, not a fabricated UI fixture. It was executed through the plugin host rather than the app's Godot project panel because the app's official pinned plugin does not expose a managed Godot session.

## Authorization and limits

- No authentic person approval was available during autonomous qualification. The approval card and service lifecycle are covered by tests; the live request was not auto-approved by the agent, and no screenshot was taken under a simulated consent. This is a qualification limit, not a claim that the person approved a live request.
- External MCP clients have no OhMyGame conversation in which to ask the person, so they cannot initiate a capture. They can read existing authorized captures.
- Capture remains Windows-only, person-initiated, one visible top-level window in the managed session's process tree, and bounded in memory. There is no native input, continuous observation or arbitrary desktop capture.
- The capture route still trusts the local desktop renderer/daemon token for delivery of an already-approved image; it does not cryptographically prove a person clicked. A compromised renderer remains outside this version's threat model.
- Godot's official pinned plugin still starts the editor rather than a managed session. The check-history path works without that release; viewport capture remains outside the pinned plugin.
