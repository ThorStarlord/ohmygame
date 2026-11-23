# Cross-engine integration pilot: Atlas (Godot) and Superhero-Netorare-Parody (Ren'Py)

**Date:** 2026-11-23  
**Status:** bounded pilot complete; both engines ran through OhMyGame, with pre-existing game debt and one save-isolation incident recorded below.  
**OhMyGame:** `ThorStarlord/ohmygame`, `dev` from `182e1eadd1f6ae4a607ed2f8efd44176a5e5a091`; merged fixes end at `e8affdfcd341eae0a1b90e49432970d6f33c46c2` before this report.  
**Atlas Midgard:** `ThorStarlord/atlas-midgard`, `main` `cae8004d91f30a28c9885e06f913d58ab4d85258` (canonical source unchanged).  
**Superhero-Netorare-Parody:** `ThorStarlord/Superhero-Netorare-Parody`, `main` `75436b0b22ea3b8bcb29a10d0102530c1c32d1ce` (canonical source unchanged; UI fix proposed in PR #302).

## Verdict

| Question | Result |
| --- | --- |
| OhMyGame's targeted automated tests | **PASS** for the targeted slice; full suite not run |
| Atlas recognized, engine found, native validation, Web build | **PASS** |
| Atlas title → Begin → Ruined Causeway → movement | **PASS**, observed in a real browser build served by OhMyGame |
| Ren'Py plugin installed, project recognized, SDK found, native validation | **PASS** for integration; project lint gate has pre-existing debt |
| Ren'Py native window, dialogue, input, save/load | **PASS** |
| Ren'Py Web preview | **BLOCKED**: installed SDK has no Web support |
| Agent-assisted inspection of both games | **PASS** (Codex CLI through OhMyGame) |
| Original Ren'Py persistent data preserved | **FAIL**: one-byte rewrite by a pre-fix baseline lint run; save slots untouched |

## Environment

- Windows 10 Home Single Language 10.0.19045, interactive desktop session.
- Bun 1.4.2, Node.js v24.14.1, Python 3.14.3, pytest 8.4.2, gh 2.104.0.
- Godot `4.7.2.stable.official.ed1daf0bf`, from Atlas `.tools/godot/4.7.2`.
- Ren'Py `8.5.2.26010301`, SDK at `H:\Renpy\renpy-8.5.2-sdk`.
- Codex CLI 0.167.0 (signed in) used through OhMyGame.
- OhMyGame daemon isolated with `OHMYGAME_DATA_DIR=H:\GithubRepositories\pilot-data\omg-data` and port 43210.

## Stage A — OhMyGame

Commands run in `H:\GithubRepositories\ohmygame-dev` on `dev`:

| Check | Result |
| --- | --- |
| `bun install --frozen-lockfile` | exit 0 |
| `bun run prepare:preinstalled-plugins` | 13 plugins prepared |
| `bun run plugin:check plugins/renpy` | “No problems found” |
| `bun run test -- test/renpy-plugin.test.ts test/godot-plugin.test.ts` | 20/20 passed on the starting revision |
| `bun run typecheck` | exit 0 |
| `bun run lint` | exit 0 |
| `bun run changelog:check` | exit 0 |
| final focused suite on merged `dev` (`extension-hosts`, `project-plugins`, `renpy-plugin`, `godot-plugin`) | 106 passed, 2 skipped, 1 failed |

The one failure is `test/project-plugins.test.ts > keeps approvals by the folder's real path and for the person only`: Windows denied creating a symlink in the temp directory (`EPERM`). It is a local Windows permission limitation, not a code regression.

The full OhMyGame suite and the cross-platform CI matrix were not run. GitHub Actions reported no checks on the fork's PR branches, so remote CI evidence is unavailable for OhMyGame.

## Stage B — Atlas Midgard (Godot 4.7.2)

A disposable worktree at `H:\GithubRepositories\atlas-pilot` was created from `main`. It adds only test isolation and OhMyGame metadata:

- `config/use_custom_user_dir=true`, `custom_user_dir_name="atlas-ohmygame-pilot-20261123"` in `project.godot`.
- `ohmygame.json` written by OhMyGame on adoption.
- `.ohmygame/build/web` build output.

Godot verified the custom user directory by writing telemetry to `C:/Users/Admin/AppData/Roaming/atlas-ohmygame-pilot-20261123/`, so the canonical Atlas `user://` profile root was not used.

### Results

| Check | Result | Evidence |
| --- | --- | --- |
| B1 project recognition | **PASS** | Project adopted as `ohmygame/godot:godot-game`; plugin `active`, `providesType: true` |
| B2 engine discovery | **PASS** | `godot_status`: `4.7.2.stable.official.ed1daf0bf`, templates `true`; settings status found the same executable |
| B3 native validation | **PASS** | `run_headless` 180 frames: exit 0, no error lines. `smoke_first_journey_title.gd` and `smoke_first_journey_route.gd` both print their OK markers |
| B4 Web export | **PASS** | Plugin `export_web`: exit 0; `.ohmygame/build/web/index.html`, `index.pck`, `index.wasm` (39.5 MB); OhMyGame preview served it |
| B5 visual observation | **PASS** | Title, Begin/How to play/story/credits/quit, Ruined Causeway, party and HUD, movement changed the scene; browser console had zero page errors |
| B6 agent interaction | **PASS** | Codex agent inspected the real title/Causeway source and identified the source of the export errors |

Screenshots: [title](../assets/pilots/2026-11-23/atlas-title.png), [Causeway](../assets/pilots/2026-11-23/atlas-causeway.png), [after movement](../assets/pilots/2026-11-23/atlas-movement.png).

### Observed Atlas defects and warnings

1. **Pre-existing game defect: Larkspur Morning parse errors.** The export printed 22 error lines. `living_restoration_presenter.gd` and `companion_bond_area.gd` call `ProgressionCatalog` members that are absent from this revision (`regional_support_active`, `REGION_LANTERN_VALE`, `SUPPORT_ARCHIVE_EXCHANGE`, `companion_bond_moment_available`, `companion_bond_moment`, `companion_bond_stage`). Both scripts are instantiated only by `larkspur_morning.tscn`; the title and Ruined Causeway do not use them. The agent confirmed the route smoke covers `larkspur_commons.tscn`, not `larkspur_morning.tscn`, which is why the regression is missed.
2. **Minor external Godot plugin warning.** The generated `Web` preset omits `include_filter`, so Godot logs `Couldn't find the given section "preset.1" and key "include_filter"` during import/export. The export still succeeds. The preset is generated by the pinned `ohmygame/godot` package, not this fork.
3. Movement with `W` or `D` for under a second can leave the small Causeway platform into empty space. This may be intended open prototype traversal rather than a defect; it is recorded only as an observation, not a claim.

The complete Atlas verifier (`verify.ps1`) was not claimed as passed. Only the title and route smokes above were run.

## Stage C — Superhero-Netorare-Parody (Ren'Py 8.5.2)

A disposable worktree at `H:\GithubRepositories\renpy-pilot` was created from `main`. For the pilot only, it sets `DEMO_BUILD = True`, uses `config.save_directory = "EvilGetFucked-Pilot-20261123"`, and contains the one-line save-screen fix verified below. The canonical repository was not modified.

### Results

| Check | Result | Evidence |
| --- | --- | --- |
| C1 plugin installation | **PASS** | Development install from `ohmygame/plugins/renpy`; version 0.1.0; native digest updated on edit |
| C2 existing project recognition | **PASS** | Adopted as `thorstarlord/renpy:renpy-game`; plugin active |
| C3 SDK discovery | **PASS** | `renpy_status`: SDK `H:\Renpy\renpy-8.5.2-sdk`, CLI `lib\py3-windows-x86_64\python.exe` |
| C4 `renpy_lint` | **Integration PASS / gate FAIL** | Ran with `--savedir`; exit 1 with 17 diagnostics. Pristine `main` produces the identical 17 |
| C4 `renpy_compile` | **PASS** | exit 0, no output |
| C4 `renpy_test` | **NOT_TESTED** | Project defines no engine-native `testcase` |
| C4 focused Python tests | **FAIL (pre-existing)** | 20 passed, 3 failed on pristine `main`: stale manuscript/prologue/full-game integration assertions |
| C5 native launch | **PASS** | Real window, demo main menu, Foundation opening, Meridian and rooftop backgrounds, NVL dialogue advanced by real clicks; no traceback |
| C6 save at known point | **PASS** | `1-1-LT1.save` (13,333 bytes) written to the isolated namespace with thumbnail and timestamp |
| C6 close/relaunch/load | **PASS** | Reload restored the same “Comms / The exits stay open…” line and rooftop background |
| C6 original persistent preservation | **FAIL** | See the isolation incident below |
| C7 Web preview | **BLOCKED** | SDK has no Web support installed (`renpy-8.5.2-sdk` has no `web` directory); not attempted |
| C8 agent interaction | **PASS** | Codex agent confirmed the duplicate page label and explained the no-sprite opening from source |

Screenshots: [opening dialogue](../assets/pilots/2026-11-23/renpy-opening.jpg), [save screen before the fix](../assets/pilots/2026-11-23/renpy-save-screen-before.jpg), [loaded state after relaunch](../assets/pilots/2026-11-23/renpy-load-restored.jpg), [page label after the fix](../assets/pilots/2026-11-23/renpy-page-label-fixed.jpg).

### Ren'Py findings

- **Lint diagnostics are baseline debt, not integration regressions.** The 17 diagnostics are 11 `'sprite iris bust …' is not an image` errors in `arc3/iris_*.rpy` and 6 undefined `daphne`/`hana`/`suzu` who-name errors. Pristine `main` produces the same set. The repository's own lint ratchet fails because its JSON baseline does not include the 11 Iris diagnostics.
- **The opening demo intentionally has no character sprites.** `prologue_demo_start` calls only `false_mc_fpa` and `false_mc_fp_elena`; those labels use `scene bg …` and NVL dialogue, never `show sprite …`. Marcus and Elena bust files exist and resolve, but the demo never requests them. This explains the observation without claiming an asset-loading failure.
- **Save-screen label defect.** `screens.rpy` combined `FilePageNameInputValue(pattern=_("Page {}"))` with a separate `label _("Page ")`, rendering “Page Page 1”. The minimal fix (remove the extra label) was applied in the disposable copy, lint/compile stayed clean, and the load screen then rendered “Page 1”. Proposed to the game repository as [PR #302](https://github.com/ThorStarlord/Superhero-Netorare-Parody/pull/302).
- **Game-menu sidebar clicks were not reliably targetable** by the synthetic click harness, while the main-menu Load button and save-slot clicks worked. This is recorded as a harness limitation, not a claimed game defect.

### Save-isolation incident (important)

The interactive pilot used a unique save namespace and preserved all existing save slots:

- Pilot namespace: `C:\Users\Admin\AppData\Roaming\RenPy\EvilGetFucked-Pilot-20261123`
  - `1-1-LT1.save`, `auto-1-LT1.save`, `persistent`
- Existing full-game namespace: `C:\Users\Admin\AppData\Roaming\RenPy\EvilGetFucked`
  - 52 files recorded; all save slots remained byte-identical.
  - `persistent` and `sync\persistent` changed from 73,347 bytes / `9581fb1c…` to 73,346 bytes / `d475a664…` at 17:15:34, during a lint run on a pristine full-game worktree **before** the plugin's save isolation was fixed. No original-byte backup was taken, so the change cannot be safely reversed.

This is a real data-safety defect in the pre-fix Ren'Py validation path: Ren'Py loads and can rewrite persistent data even for lint. The plugin now passes a throwaway `--savedir` to lint, compile and tests. After the fix, repeated lint and compile left the current original persistent hash unchanged (`d475a664…`), and the regression test asserts the temporary directory is used and removed.

## Defects and repairs

| Defect | Owner | Status |
| --- | --- | --- |
| Adopting an existing folder as a plugin project type recorded folder approval but not app consent, leaving the chosen plugin `needs-consent` and unable to run | OhMyGame core | Fixed in [PR #2](https://github.com/ThorStarlord/ohmygame/pull/2), merged `26586992` |
| `runInRenpy` returned at spawn, so the extension host idled out after 5 minutes and killed the native game | Ren'Py plugin | Fixed in [PR #3](https://github.com/ThorStarlord/ohmygame/pull/3), merged `e8affdfc`; command now stays pending for the game lifetime with a 3600 s timeout |
| Lint/compile/test rewrote the player's real Ren'Py `persistent` | Ren'Py plugin | Fixed in PR #3: throwaway `--savedir`, removed afterwards |
| Save/Load screen shows “Page Page 1” | Game project | Fixed in disposable copy and visually verified; [PR #302](https://github.com/ThorStarlord/Superhero-Netorare-Parody/pull/302) open, blocked by an unrelated pre-existing `renpy-game-integrity` failure on `main` |
| Larkspur Morning calls absent `ProgressionCatalog` members | Atlas game | Pre-existing; not repaired in this pilot. Agent report and exact files recorded |
| `Web` preset omits `include_filter` | External `ohmygame/godot` package | Pre-existing; export succeeds. Not repaired in this fork |
| Ren'Py lint baseline omits 11 Iris diagnostics; 3 focused Python tests fail | Game project | Pre-existing; not repaired |

## Agent-assisted developer experience

Two real OhMyGame conversations used the Codex CLI (`gpt-5.6-sol`, medium effort) with shell and file tools:

- The Atlas agent traced the parse errors to two unused-by-the-route Larkspur scripts and confirmed all named members are absent from the current `progression_catalog.gd`. It also noted the route smoke covers `larkspur_commons.tscn`, not `larkspur_morning.tscn`.
- The Ren'Py agent confirmed the duplicate label cause and verified the demo path has no `show sprite` statements, while the Marcus/Elena bust assets exist and resolve.

This was more effective than a chat-only agent because OhMyGame supplied the project folder, plugin context, engine tools and a persistent conversation. It was not a controlled productivity comparison, so no speed or productivity gain is quantified.

## Evidence limitations

- The OhMyGame desktop **UI shell** was not automated with screenshots. Project adoption, plugin installation, native commands and preview builds used the same daemon HTTP routes and extension-host paths the UI calls; the Web build was served by OhMyGame's preview proxy and played in an isolated Chromium profile.
- GitHub Actions on the OhMyGame fork reported **no checks** for PRs #2/#3. Merges relied on the local focused suite and real-engine evidence.
- The game PR's `renpy-game-integrity` failure is pre-existing on `main`; it was not bypassed.
- Ren'Py Web support is absent from the installed SDK, so browser preview remains untested.
- The full Atlas verifier and full OhMyGame test suite were not run.
- The synthetic desktop harness could not reliably click the Ren'Py game-menu sidebar; main-menu, dialogue and save-slot interactions did work.
- No performance measurements or comparative productivity claims are made.

## Recommendation

Continue using OhMyGame with both engines. The core path now works: project recognition, engine discovery, native validation, Web preview for Godot, native launch/save/load for Ren'Py, and agent inspection. The remaining friction is concentrated in engine/plugin lifecycle and project-level debt, not in whether OhMyGame can work with these games.

**Next highest-value bounded improvement:** give plugin-launched native processes a first-class keep-alive/lifetime contract in the extension host, so every engine (including the external Godot plugin's **Run in Godot**) gets the same protection as the Ren'Py fix instead of relying on a command staying pending. Also add `include_filter=""` to the Godot plugin's generated Web preset. Neither requires changing OhMyGame's core product scope.
