# Engine observations and authorized native window capture

**Date:** 2026-11-25
**Status:** PR #10 integration completed locally, including a real desktop workflow against a disposable Ren'Py project; Web playtesting and native input remain unsupported.
**OhMyGame:** `ThorStarlord/ohmygame`, branch `feat/engine-observations`, based on `dev` `792e9e19884b1900dd5049d7e843e542486f2042`; candidate `5fe88f2c6c3eaceed6b8b35e66a8bc6d42ad961e` (continues `4ca7e63a8e568b55280ba93206c79cda61322539`).
**Disposable project:** `H:\GithubRepositories\renpy-pilot`, a pilot copy of Superhero-Netorare-Parody; canonical game source and player data were not used for the exercise.

## Delivered

- Project-scoped Problems & engine status panel with recent checks, preview diagnostics, managed native sessions, source links, diagnostic paging and comparison.
- `engine_observations` for the project agent and external MCP clients; bounded history and output on request.
- Bounded stdout/stderr observation for a managed native session whose plugin opts in at launch.
- Person-authorized Capture window for the Windows desktop app. It finds a visible top-level window owned by the session's process tree, excludes console classes, captures a scaled PNG with blank-frame analysis, and stores it in daemon memory.
- `engine_capture` returns the latest authorized capture as image content; it cannot trigger a capture, choose a window or request permission.
- The panel lint action is a read-only native command, records check history, and does not create an Undo entry.

## Desktop exercise

The application was built with `bun run build:host` and `bun run build:renderer`, launched with a temporary `OHMYGAME_DATA_DIR`, and the current Ren'Py plugin was installed from its folder. A disposable project adopted `renpy-pilot`.

Observed:

- Managed Run in Ren'Py kept a session with PID and bounded output.
- Capture window produced a real 1920 x 1112 PNG of the Ren'Py main menu titled `Evil get fucked!`; blank analysis reported `likelyBlank: false`.
- The Problems panel rendered the capture, session state, diagnostics and source links.
- Ren'Py lint recorded 17 reported findings. Open source file opened `game/scripts/arc3/iris_ch1.rpy` at the reported line.
- The project's Web export failed with a real Ren'Py `web.rpy` recursion error; the failure was reported in the panel and did not crash the extension host after generated saves/cache were excluded from preview rebuilds.

Disposable fix:

- Added matching `direct_engagement`, `controlled_concern` and `quiet_vulnerability` image aliases for Iris bust/portrait/side definitions in the disposable copy.
- Rechecked lint: 6 findings remained, 11 no longer reported, 0 newly reported. The comparison was displayed in history.
- Reverted the disposable source edit and removed the old probe file after the exercise; canonical game content and saves were untouched.

Godot observation:

- Ran the disposable Atlas pilot with Godot 4.7.2 and a temporary user directory.
- The same capture adapter produced a real 1920 x 1124 image of the Atlas title screen, `likelyBlank: false`, from the selected Godot process tree.
- This was a direct adapter qualification, not yet a managed `Run in Godot` session: the official pinned Godot plugin still launches the editor, so the app-level native-session path remains Ren'Py-only.

## Verification

- `bun run test -- test/preview.test.ts test/external-mcp.test.ts test/renpy-plugin.test.ts test/engine-check-history.test.ts test/native-output.test.ts test/native-window-captures.test.ts` - 81 passed, 2 skipped.
- `bun run test -- test/app.test.ts` - 92 passed.
- `bun run test -- test/extension-hosts.test.ts` - 63 passed, 2 skipped.
- `bun run typecheck`, `bun run lint`, and `bun run plugin:check plugins/renpy` - pass.
- `test/agent-tools.test.ts -t "reads only a person-authorized native capture"` - pass. Two unrelated existing Windows symlink fixtures in that file fail with `EPERM` in this environment.
- Desktop capture and lint/source navigation were exercised through the actual built Electron app; evidence is local, not remote CI.
- Evidence log: `H:\GithubRepositories\pilot-data\evidence\engine-observations-desktop.json.log`, `renpy-native-capture.png` and `atlas-native-capture.png`.

## Limitations

- Native window capture is Windows-only and limited to a visible top-level window owned by the session's process tree. Console windows are excluded; multiple game windows are refused rather than guessed.
- Capture is person-initiated. The agent can read a retained capture but cannot start one.
- No native input automation, continuous video, engine-internal game state, or screenshot after the retained capture is evicted.
- Ren'Py Web export remains unqualified with the installed SDK; the disposable project's own Web build fails in Ren'Py's `web.rpy`.
- The capture is a scaled still image, not proof of gameplay or correct state. Preview/native state and check history are daemon-memory evidence with unknown source freshness.
- No remote GitHub checks are reported for the branch.
