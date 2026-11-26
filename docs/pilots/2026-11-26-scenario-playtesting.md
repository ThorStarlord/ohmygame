# Engine-aware scenario playtesting v1

**Date:** 2026-11-26
**Status:** Implemented and exercised with the real Ren'Py 8.5.2 SDK on Windows. The development exercise used a disposable copy of Superhero-Netorare-Parody; the canonical game was not modified. Real runs verified discovery, a normal checkpoint replay, a refused screenshot-path escape, and regression match and mismatch.
**OhMyGame:** `ThorStarlord/ohmygame`, branch `feat/scenario-playtesting`, based on `dev` `76117505f9ea1f611973635ea1b56c57b557ca82`.

## Product capability

An in-app coding agent or developer can:

1. Ask the loaded Ren'Py engine which project-defined testcases and testsuites it registered.
2. Run a specific testcase or testsuite, or the default global suite.
3. Collect the actual engine-rendered images produced by the testcase's `screenshot` statements.
4. Retrieve an exact checkpoint by stable identity.
5. Replay the same scenario after a bounded change.
6. Compare corresponding checkpoints with an explicit comparability judgment.
7. Read partial checkpoints and the engine output captured before a failure, timeout or cancellation.

Ren'Py remains the authority for scenario parsing, selection, gameplay, assertions and screenshots. OhMyGame supplies the disposable execution environment, bounded evidence storage, agent tools and developer surface. There is no second scenario language and no replacement test runner.

## Supported Ren'Py contract

The installed SDK is Ren'Py `8.5.2.26010301` at `H:\Renpy\renpy-8.5.2-sdk`.

Verified from the SDK source and real execution:

- `renpy.py <basedir> test [testcase]` selects a named testcase or testsuite; no argument keeps the existing `global` suite.
- A missing selection exits 1 during initialization with `KeyError: 'TestCase <name> not found.'`. This is reported as `not-found`, not as a failed scenario.
- Testcases can drive the game through `run Start("label")`, `advance`, `click`, selectors, `assert`, `python`/`$` and `pause`.
- `screenshot "<path>"` saves a real engine-rendered PNG. The engine resolves it under `renpy.config.basedir` plus `_test.screenshot_directory`, and compares it with an existing reference when one exists.
- The engine's console report distinguishes passed, failed, skipped and not-run outcomes; screenshot mismatches raise `RenpyTestScreenshotError`.
- `_test.screenshot_directory` and `_test.vc_revision` are store settings available before init code. A mirror-only `init 999 python` file redirects screenshots into the run folder, keeps names stable, and installs a resolved-path guard on the engine's `screenshot` statement.
- An explicit `exit` in the testcase ends the run instead of leaving the test waiting for a return to the main menu. The generated discovery probe also ends with `exit`; without it discovery waited until the timeout even though the engine had already printed `Status: PASSED`.
- A failed testcase can print its final report and then wait. The runner stops the engine when that report arrives and uses its status for the exit code, so a failure is returned promptly instead of becoming a timeout.

## Execution and isolation

`renpy_scenario_run` prepares the same disposable project-shaped mirror used by lint, compile and `renpy_test`:

- `game/saves` and `game/cache` are omitted; root `state/` is copied; other root resources are linked with the existing limitations.
- A throwaway `--savedir`, `RENPY_PATH_TO_SAVES` and `RENPY_MULTIPERSISTENT` keep generated saves and persistent data out of the player's namespace.
- Screenshots are redirected to `game/.ohmygame-scenario/<runId>/screenshots` in the mirror, and the guard resolves every `screenshot` statement's real path. A path that leaves that controlled folder, including a `..` filename or a symlink/junction, fails the scenario before any file is written. This was verified with a real escape attempt against a linked root `tests/` directory: the run failed with the guard message, produced no checkpoint, and did not create the canonical file.
- Only engine-created PNGs from that controlled directory are copied to the project's transient staging folder, `.ohmygame/scenario-runs/<runId>/checkpoints/`. The app resolves each staged file's real path and refuses one reached through a parent junction.
- The app ingests those files into daemon memory, removes the staging copy, and retains bounded evidence. The plugin also prunes old staging runs when a direct plugin call leaves them.
- Canonical source, player saves, persistent data, compiled artifacts and screenshot baselines are not promoted or overwritten by the app or by the screenshot mechanism. Project Python still runs with the user's authority and can write through linked resources; that is outside the screenshot guard.

The existing mirror is still path-based, not a filesystem sandbox. Project init code and testcases can write through linked root resources with the user's authority; player data under another name or through `config.extra_savedirs` remains outside its guarantees. A scenario run that needs a stronger sandbox is not claimed.

### Exploratory and regression modes

- **Exploratory** runs in a fresh screenshot directory and keeps every `screenshot` result. A difference is expected and is not interpreted as a regression.
- **Regression** copies the project's baseline PNGs from `tests/screenshots` (or an explicit safe project-relative folder) into the disposable run directory, then lets Ren'Py compare. Mismatches produce `.new` and `.diff` images and fail the scenario. The project's baselines are never modified.
- A matched baseline is not presented as a fresh checkpoint: the engine does not save a new image on a match, so the run reports the pass without treating the copied reference as a newly executed screenshot and warns that no new screenshots were produced.
- A baseline folder that is a symbolic link, outside the project, larger than 512 files or 128 MiB, containing unsafe paths, or containing no usable PNG is refused. Screenshots without a matching baseline are marked `no-baseline` and warned about rather than treated as compared.
- The engine's final report distinguishes passed, failed and skipped runs. A selected testsuite that executes no testcase is reported `skipped` and recorded as `unknown` in check history, not as a pass.

## Evidence architecture

Scenario runs are integrated with the existing engine observations rather than a second subsystem:

- `ScenarioRuns` retains up to 8 runs per project, 24 projects, and 40 checkpoint summaries per run. Images keep the same 12 MiB decoded and 16 million pixel limits as native captures.
- The scenario store retains up to 32 MiB encoded per project and 128 MiB daemon-wide. It keeps the newest runs' images first; when the project budget is exceeded, it evicts the oldest complete run's images to metadata. When a single run is larger than the project budget, it keeps its earliest checkpoints and marks the rest `retained: false` with metadata. Exact retrieval never substitutes another image. A checkpoint that was missing or invalid at ingestion is also `retained: false`; the run's warnings say which case occurred.
- `engine_observations` includes `scenarioRuns` with the scenario, mode, status, executed selection, diagnostics, checkpoint order, dimensions, capture time, retention state and warnings.
- The existing check history records a scenario execution as a `test` check with a `subject` of `<scenario>:<mode>`. Comparisons only occur between the same subject, so unrelated scenarios are not compared.
- A scenario checkpoint is a distinct evidence type from a native desktop capture. It has no HWND, root PID, managed-window identity or observation grant; those values are not fabricated for it.

Checkpoint order is the file-write order the engine produced, using file modification time with a name tie-breaker. The engine exposes no step counter; the order is not an exact action identity. Source revision and exact narrative state are not recorded and remain unknown.

## Agent workflow

New in-app tools:

- `engine_scenarios` — engine-authoritative discovery in a disposable mirror.
- `engine_scenario_run` — run a selected testcase/suite and return status, diagnostics and checkpoint metadata (no base64 images).
- `engine_scenario_checkpoint` — read one exact retained checkpoint by ID.
- `engine_scenario_compare` — read two exact checkpoints and report whether they are directly comparable by scenario, checkpoint name, mode and dimensions.

The scenario tools are registered only when the project has an active Ren'Py plugin that provides scenario execution. `engine_scenarios` starts a generated testcase, so planning mode receives only the read-only checkpoint and comparison tools, not discovery or execution. `engine_observations` accepts a scenario run's `runId`; its summary lists scenario diagnostics and checkpoint metadata but omits the stored output excerpt unless `includeOutput` is set. Stored scenario output, diagnostics and warnings pass through the plugin's observation redactor.

The existing `engine_capture`, `engine_capture_request`, observation-grant tools, `renpy_test` and `engine_observations` semantics are preserved. Scenario execution does not require a desktop observation grant because it is an explicit engine test in a disposable mirror, not a capture of an existing window.

External MCP still does not receive the daemon scenario tools. It can use the Ren'Py plugin's own `renpy_scenario_run` tool through the existing plugin-tool authority, but cannot use the app's bounded scenario-checkpoint retrieval or comparison tools.

## Developer workflow

Problems & engine status now includes **Scenario playtests**:

- The section appears only when the project has an active scenario-capable Ren'Py plugin.
- Discover engine-registered scenarios explicitly; discovery is not run automatically on panel open.
- Select a scenario, exploratory or regression mode, and a project-relative baseline folder in regression mode, then run it explicitly.
- Read status, engine selection, available baseline count and folder, structured diagnostics, bounded engine output, and checkpoint warnings.
- View ordered checkpoints, including an explicit not-retained state. A cached image is not shown after its checkpoint is no longer retained.
- Pick two retained checkpoints for before/after comparison; the view states whether the pair is comparable and why.
- Ask the agent to inspect a specific run by its retained run ID.

The Game workspace, managed native sessions and existing window-capture comparison remain separate.

## Authentic development exercise

### Project and instrumentation

A disposable project at `C:\Users\Admin\AppData\Local\Temp\opencode\superhero-scenario-exercise` was made from the canonical pilot's `game/` and `state/`; player saves and cache were excluded. The canonical Superhero-Netorare-Parody repository was not modified.

Project-local testcases were authored as instrumentation:

- `iris_expression_scenario` captures 14 frames from the existing `dev_iris_expression_qa` label.
- `iris_focused_portrait_scenario` captures only the three comparison-relevant frames and is the reusable instrument for the defect.
- `escape_scenario` attempts a `../../../../tests/screenshots/...` screenshot path to verify containment.

The first two use `run Start("dev_iris_expression_qa")`, `advance`, `screenshot` and `exit`. `preferences.text_cps = 0` is test-only setup so each checkpoint shows a complete dialogue line. The escape testcase exists only in the disposable copy.

### Defect observed

The existing expression QA label shows the focused portrait with:

```renpy
image sprite iris portrait focused = "sprites/iris_portrait_evaluating.png"
```

The canonical file is a 67-byte, 256x256 invalid placeholder. In the real run, frame `expression/11-portrait-focused` showed the engine's load error:

```
could not load image 'sprites/iris_portrait_evaluating.png': error(...)
```

The run itself passed with 14 checkpoints and no engine diagnostics; the missing sprite was a visual defect that an exit-code-only or assertion-only check would not reveal. Lint and compile were not part of this visual exercise, so they are not claimed to miss or catch it.

A valid 230x300 asset already existed at `game/images/sprites/v2_integration_fixed/iris_portrait_evaluating.png` (109,273 bytes, SHA-256 `F667561159B25B8583E00CFD81937BE2AC5857CC1105294C2D053D372AF856C8`). The bounded fix copied that asset to the expression path inside the disposable project. No script, transform or story content was changed.

### Before and after

Both 14-frame exploratory runs completed with status `passed`, exit code 0, no diagnostics and 14 retained checkpoints:

- Before: the focused portrait is absent and the load error is visible.
- After: the focused portrait renders on the workspace background.

The same-session focused comparison ran twice through the daemon service and store:

- Both runs: `passed`, 3 checkpoints, all retained.
- `comparable: true` — same scenario, checkpoint name, observation mode and dimensions.
- Retained bytes across both runs: 10,010,492 (about 9.5 MiB), within the 32 MiB project budget.
- The before image still has the load error; the after image has the portrait.
- The remaining textbox overlap and the focused expression's approved-art status are separate observations, not established by this fix.

### Discovery and screenshot containment

The generated discovery testcase was re-run after adding its `exit` and returned `passed`, exit code 0, and the engine-registered list (`escape_scenario`, `global`, `iris_expression_scenario`, `iris_focused_portrait_scenario`) in about one second.

A real escape testcase used `screenshot "../../../../tests/screenshots/escaped-by-scenario"` against the disposable project's linked root `tests/`. The scenario failed with the guard message, exit code 1, zero checkpoints, and no file at the canonical path. The same build then ran the focused three-frame scenario normally and passed with all three checkpoints. This proves the guard does not block valid screenshot names.

### Regression comparison

With the focused three-frame images copied to the disposable project's `tests/screenshots/focused/`:

- A matching regression run returned `passed`, exit code 0, `baselineFiles: 3`, no new checkpoints, and the explicit "no new screenshots were produced" warning.
- After replacing one baseline with a different image only inside the disposable project, regression returned `failed`, produced `mismatched` and `difference` checkpoints for `focused/02-portrait-focused`, and left the baseline file's bytes unchanged. The correct baseline was restored after the check.

### Retention finding

The 14-frame 1738x977 exploratory runs retained about 22.6 MB encoded (21.5 MiB) each. Two such runs would exceed the 32 MiB project budget, and the older run's images would be evicted to metadata first. Those two runs were produced by separate harness processes with separate stores, so eviction itself was not observed; the focused three-frame pair is the exercise that ran in one store. The product reports eviction explicitly, and the measured limit is recorded rather than silently raising the budget. The three-frame scenario is the reusable comparison instrument, consistent with collecting decision-relevant evidence rather than maximizing screenshot quantity.

### Evidence

- `H:\GithubRepositories\pilot-data\evidence\scenario-playtesting\before` — 14-frame clean before run.
- `H:\GithubRepositories\pilot-data\evidence\scenario-playtesting\after` — 14-frame clean after run.
- `H:\GithubRepositories\pilot-data\evidence\scenario-playtesting\focused` — same-session three-frame runs, comparison metadata and compared images.
- `H:\GithubRepositories\pilot-data\evidence\scenario-playtesting\guard` — fixed discovery, refused escape run and normal checkpoint run.
- `H:\GithubRepositories\pilot-data\evidence\scenario-playtesting\regression` — matching and mismatching real regression runs, including `.new`/`.diff` images.
- `H:\GithubRepositories\pilot-data\evidence\scenario-playtesting\logs` — engine and harness logs.
- `H:\GithubRepositories\pilot-data\evidence\scenario-playtesting\instrumentation` — the authored testcases and harnesses.

## Verification

- Focused scenario/plugin/store/service/route/UI/check-history suite: 113 passed across 10 files.
- Final scenario and engine-check-history suite: 50 passed.
- External MCP and Godot plugin suites: 16 passed.
- Existing evidence UI/capture suites: 23 passed.
- Agent scenario-tool test: passed.
- `bun run typecheck`, `bun run lint`, `bun run plugin:check plugins/renpy`, `bun run build:host` and `bun run build:renderer`: pass.
- The application suite: 92 passed on the frozen code.

The real SDK evidence above is separate from these mechanical checks. These tests use fake executors for deterministic coverage; the pilot's before/after, guard and regression runs are actual Ren'Py 8.5.2 execution through the plugin and daemon service. The authenticated HTTP route, renderer and packaged desktop application were not driven end to end for this exercise; those surfaces are covered by contract and renderer tests rather than a real engine run.

## Limits and unsupported capabilities

- No canonical game or player save was changed; the fix is demonstrated in a disposable copy.
- No authentic person approval was needed or claimed for this engine-native execution.
- No desktop window capture, generic native input, continuous capture, video or permanent archive was added.
- Godot scenario execution, a universal scenario language and cross-engine parity are not included.
- Regression comparison is engine-native, not a new image-difference engine. Matched screenshots are not enumerated by the engine and are not presented as fresh checkpoints.
- The mirror's linked-resource and custom-save-path limitations remain.
- Source revision, exact narrative state and test-action identity are not established unless the engine or repository provides them.
- A changed image is evidence; the agent's interpretation, the likely cause and any claim of improvement remain separate judgments.
- Discovery runs a generated testcase inside the global suite, so the project's `before testcase` hooks run. A hook that waits indefinitely can make discovery time out; that is an engine test-hook limitation, not an authoritative scenario answer.
- The `__ohmygame_discover_` testcase-name prefix is reserved for the generated discovery probe and is filtered from results.
- The screenshot guard covers Ren'Py's `screenshot` statement. Project Python in an init block or testcase still runs with the user's authority and can write through linked resources or custom save paths.
- The 14-frame retention finding is measured, but real eviction was not observed in a single store; the focused pair stayed below the budget. Eviction logic is covered by store tests.
- The application suite and focused tests were run on Windows; macOS/Linux and broader project shapes remain a separate qualification.
