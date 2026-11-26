# Interactive engine-aware playtesting v1

**Date:** 2026-11-26
**Status:** Implemented and exercised through the built OhMyGame desktop application with Codex `gpt-6.2-sol` and the real Ren'Py 8.5.2 SDK on Windows. The interactive session ran in a disposable copy; the canonical game was not opened or modified by the live adapter.
**OhMyGame:** `ThorStarlord/ohmygame`, branch `feat/interactive-playtesting`, based on `dev` `0e3726fbb1be8e7eb63f15c4a967143191bc780c`. The pull request and final mission report record the merge revision.

## Product capability

`game_use` can now investigate a Ren'Py game instead of only running a predetermined test. The initial vertical slice is:

| Operation | Purpose |
|---|---|
| Open | Start an isolated Ren'Py session and reach the first interactive state |
| Inspect | Read the current dialogue, choices, screens, interaction id, and supported actions |
| Advance | Advance the currently awaiting dialogue |
| Choose | Select a choice that is currently available in the inspected state |
| Capture | Obtain the current engine-rendered frame |
| Close | Quit the engine, remove the copied project, and release the session |

The important change is that the next action can depend on the state returned by the previous one. The agent may read a line, advance it, observe a transition, wait for the next state, reach a choice, and choose from the captions it actually saw. That is live interactive playtesting, not a scripted scenario replayed through several tool calls.

## Selected architecture

The selected architecture is **Approach B, a narrowly scoped engine-native adapter inside the existing plugin-backed `game_use` runtime**. It is not a second playtest system and it does not replace the scripted scenario workflow.

- The Ren'Py project type declares `gameUse` with `inspect`, `act`, and `capture`, and with `narrative` input.
- The plugin's `gameUse` hook owns the child process, the copied project, the session id, and the socket.
- The daemon's existing `PluginGameRuntime` owns the app-visible session, its version checks, capture scaling, idle close, and conversation ownership. `game_use` exposes only the operations the type declares.
- The renderer, agent timeline, permissions, and evidence lifecycle remain the existing ones.

Alternatives considered:

- **Approach A, existing runtime integration only.** Ren'Py has no supported general-purpose live-control API addressed from outside the process. `renpy.queue_event` and the test focus/mouse path work, but they need to run inside the engine and need a control channel. Using only existing scenario execution would be repeated scripted runs, not live interaction.
- **Approach C, repeated native scenario execution.** This remains the right tool for known, reproducible behavior and is preserved. It cannot satisfy the observation-action-observation requirement because the sequence is fixed before execution.
- **A replacement runner, universal scenario language, generic desktop input, or unrestricted automation.** Rejected: all of them would duplicate engine authority or exceed the bounded product responsibility.

## Verified Ren'Py contract

The installed SDK is Ren'Py `8.5.2.26010301` at `H:\Renpy\renpy-8.5.2-sdk`.

Verified from SDK source and real execution:

- `renpy.invoke_in_thread` starts the adapter thread; `renpy.invoke_in_main_thread` runs inspection and input on the engine's main thread. A queued wake event makes the next interaction process the callback.
- `renpy.queue_event("dismiss")` advances an awaiting say. A queued event is needed because the main-thread callback runs in an interaction context.
- `renpy.get_screen("choice").scope["items"]` exposes the current choice captions and actions.
- `renpy.test.testfocus.find_focus(caption, False)` and `renpy.test.testmouse.click_mouse(1, x, y)` select a choice through Ren'Py's own focus and test-mouse path, rather than synthesizing desktop input or invoking the action directly.
- `renpy.last_say()` returns the current `who`/`what`; `renpy.get_statement_name()` reports statements such as `say`, `menu-with-caption`, and `with`; `renpy.get_ongoing_transition()` reports an active transition.
- `renpy.screenshot(path)` writes a real engine-rendered frame. The adapter confines the path to the session's capture folder.
- Starting the game through `renpy.jump_out_of_context("start")` raises `JumpOutException`; the adapter treats that as control flow, not as a failed action.
- A normal action refusal must not be re-raised into the engine. An earlier implementation did, and a refused advance during a transition terminated the session. The adapter now returns the refusal and leaves the session alive; a real SDK probe confirmed the recovery.

### Observed state

`inspect` returns a `gameState` with `kind: "renpy"` and:

- `status`: `main_menu`, `awaiting`, `transitioning`, `finished`, or `unknown`.
- `interactionId`: a digest of the current statement, dialogue, label, screens, and choices.
- `label`, `statement`, `screen`, and `screens`.
- `speaker` and `dialogue` when the engine reports them.
- `choices`: stable `choice-N` ids with captions and whether the engine marks one chosen.
- `canAdvance`, `canChoose`, and the engine viewport.

The adapter does not expose the game variable namespace, arbitrary Python evaluation, shell commands, or unrelated screens. A field is present only when the engine provides it; the client does not invent a speaker or dialogue. Screen names are observations, not a semantic interpretation of the scene.

### Action semantics

- `advance` sends a dismiss only when the current state is awaiting dialogue. During a transition it is refused with `dialogue is not awaiting an advance; inspect the current state`.
- `choose` requires both the choice id and the interaction id it was observed in. The adapter recomputes the current interaction id and refuses a stale choice instead of applying it to a different screen. A direct SDK probe confirmed `ValueError: stale interaction; inspect the current choices before choosing`.
- The tool does not automatically retry uncertain actions. The result distinguishes the action being accepted, the engine executing it, and the follow-up state being observed; a missing or ambiguous result is reported, not advanced again.
- A choice that is not present in the current state is refused. Choice selection uses the engine's own focus and mouse path.
- `close` asks the engine to quit. Closing an already ended session is treated as done by the app runtime.

## Isolation and lifecycle

The live session does not run the canonical project.

- The plugin copies the project's `game/` tree and root `state/` into a temporary folder, excluding `game/saves`, `game/cache`, and symbolic links. Root resources are copied rather than linked, so canonical writes through a linked root are not introduced by this path.
- The SDK runs with a throwaway `--savedir`, `RENPY_PATH_TO_SAVES`, and `RENPY_MULTIPERSISTENT`, all inside the temporary folder.
- A generated `init 999` file starts a loopback-only adapter inside the copied game. The endpoint file and a random session token are created in the session folder. Every request is token-checked with a constant-time comparison.
- The adapter supports only inspect, start, advance, choose, capture, and close. Capture paths must resolve inside the session's capture folder.
- The plugin keeps the child process and copied project until close, then quits the engine, terminates the child if needed, and removes the folder. The plugin closes all remaining sessions on disposal. The app limits open sessions per project and closes them on idle, conversation cleanup, or project close.
- If the extension host is killed without running its disposal hook, the operating system may leave the engine child for separate cleanup. This remains a lifecycle limitation.
- Project code still runs with the user's authority. `config.extra_savedirs` or other absolute paths in project code are not sandboxed by the copied folder. The live adapter is not claimed as a filesystem sandbox.

## Developer and agent experience

- `game_use` appears when the project's type reports `gameUse`. A `web-build` type such as Ren'Py can keep its Web preview and still run `game_use` through its plugin; the project records `pluginType.gameUse` so this is visible without changing the preview.
- The agent timeline shows the session id, the inspected state, each narrative action and result, captures, and the close call. The existing `game_use` cards and translations handle the new actions.
- The agent is told to read `gameState`, use the latest `interactionId`, inspect after each action, inspect again during a transition rather than sending input, and close the session when finished.
- A developer can stop a live session by asking the agent to close it, ending the session, or closing the project. The scripted Scenario playtests panel remains the reproducible regression surface; interactive play is not mandatory when a scenario is cheaper or more deterministic.
- The Scenario playtests panel comparison now defaults to the same checkpoint name from a prior run. When no prior run has that name, it says so and offers a “Choose a checkpoint” placeholder instead of silently comparing different names. This defect was reproduced in the app and repaired; after the fix, two runs defaulted to `01-opening` from both runs and reported them comparable.

## Authentic exercise

### App agent, first live session

Codex `gpt-6.2-sol` ran in the built app against the disposable `renpy-app-probe` project. It opened session `plugin-df94ae14-4467-4f6a-8edd-78b007c7b02e` at the first `say` state. After one rejected `inspect` that omitted the session id, it inspected and received the narrator's lecture line. It then sent five single-step advances, each with the interaction id from the state it had just inspected:

1. The lecture line advanced to “Professor Eileen's lectures are usually interesting, but today I just couldn't concentrate on it.”
2. That advanced to “I've had a lot of other thoughts on my mind...thoughts that culminate in a question.”
3. That advanced to “It's a question that I've been meaning to ask a certain someone.”
4. The next result was a `with` transition with no say screen; the agent inspected again and received “When we come out of the university, I spot her right away.”
5. It captured the campus walkway, advanced, inspected, and reached “I've known Sylvie since we were kids.”

It captured a second frame showing Sylvie centered on the same background, described the reveal, and closed the session. Its report distinguishes the still-frame order from the unverified exact transition timing, and it does not claim a visual improvement.

The app retained the two engine captures as bounded conversation images. Both are 1280×720; the original engine PNG metadata reported a non-blank analysis (`opaqueRatio` 1.0, luminance variance about 5,450 and 5,620). The app copies are:

- `01-campus-walkway.jpg`, 206,574 bytes, SHA-256 `80CCC50CC557C24DF4148F00A6D85FFD63763D1BC4703B92E4A95F5F7CABFB45`.
- `02-sylvie-reveal.jpg`, 214,836 bytes, SHA-256 `C4E3D29D67564942317B785028C6ACBB144AB329B966DE648F8663D792D7274A`.

### App agent, choice session

The same agent then opened a fresh session `plugin-061a9b8c-4a8f-44a2-9da4-151bf9dc118a` and sent eight one-at-a-time advances, inspecting after each. It observed two transitions, let them settle, and reached the menu at interaction `07fd1add7eea2d698111` with:

- “To ask her right away.”
- “To ask her later.”

It chose “To ask her right away.” because the narrator had just said they wanted more than talking and walking home. The `choose` result and a separate `inspect` both showed the menu cleared and Sylvie saying “Hi there! How was class?”. It captured that frame and closed. Its report explicitly leaves the other branch and later story unverified. The capture is 1280×720 and is retained as `03-choice-consequence.jpg`, 208,207 bytes, SHA-256 `5EEE49C2D7D5EB1B8AAA604F70758A1AF2FA4D20E23E9E294E563AEF6A60A493`.

### Direct SDK probe

A direct module probe against `the_question` confirmed the same lifecycle without the app model:

- Opened a real session and advanced to a choice through actual engine state.
- Observed four `transitioning` states, including transitions where the say screen remained visible. An advance sent during a transition was refused with the error above and the session remained usable.
- Chose `choice-0`, observed the Sylvie greeting, and confirmed a stale choice was refused.
- Captured a 1,691,632-byte engine-rendered PNG and closed cleanly.

The app sessions above ran before the final transition classification. Their agents saw the `with` state and correctly inspected again rather than forcing an advance; the final adapter reports that state as `transitioning` and refuses advance until dialogue is awaiting input.

### Scenario app workflow

The built app also exercised the existing scenario path end to end:

- Discovery through Problems & engine status returned the engine-registered `app_probe`, `bad_end`, `global`, `good_end`, and `history_screen_from_quick_menu` entries.
- Two exploratory `global` runs passed with two 1280×720 checkpoints each.
- The checkpoints were retrieved by exact id through the app and through Codex's `engine_scenario_checkpoint` tool.
- Codex called `engine_scenario_compare` on corresponding `01-opening` checkpoints and reported `comparable: true` after the panel fix.
- The two `01-opening` images were byte-identical in the repaired UI run (SHA-256 `c61db4c0bd0f28cdd2670f1fe2fb879cc8e4286392d1fc73bd7345dca6b53fe1`); a visible difference is not claimed.

## Adaptive investigation guidance

The existing scenario tools remain the first choice for known reproducible behavior. The Ren'Py Skill now tells the agent to:

- discover the testcases the engine registered;
- use a focused scenario for a repeatable question;
- use `game_use` when the next action genuinely depends on newly observed state;
- keep temporary investigation testcases separate from retained regression testcases;
- never promote an exploratory screenshot into a baseline automatically;
- retrieve checkpoints by exact id and compare only corresponding names, modes, and sizes.

The app exercise used the existing `app_probe` scenario for reproducibility. The live session is the authentic adaptive exercise; an agent-authored temporary scenario remains a supported workflow, not a claim that this particular exercise authored one.

## Canonical Iris repair

The defect demonstrated during the earlier scenario pilot was repaired in the canonical game repository, not only in a disposable copy.

- Repository: `ThorStarlord/Superhero-Netorare-Parody`.
- PR #349, `fix(iris): restore focused portrait asset`, merged into `main` at `4b192ebd34fa76258ad7e360f2e8de729a55bf8c`; repair commit `18b3311f`.
- `game/images/sprites/iris_portrait_evaluating.png` was a 67-byte malformed placeholder on `main`. The repair uses the qualified v3 production portrait from the unmerged source branch `a451d80e`, applying the repository's documented alpha-only inversion.
- Final asset: 119,090 bytes, 230×300 RGBA, SHA-256 `4f333b5f025cf33f63fc9f40052a07f0e2d2bfe8d4bc438a212327e91e4c27ac`.
- The focused Ren'Py testcase `iris_focused_portrait_qa` failed on the clean tree with “Error reading the PNG file” and passed after the repair (exit 0, 3/3 assertions). The rendered frame was 1,739×977 and identical on a repeat run.
- The focused pytest set passed (9), the ADR-004/ADR-005 Sandbox suites passed (32), and `validate_expression_integrity.py --json` passed.
- Limits: the source package is from an unmerged branch with local validation, the acceptance authority was `CODING_AGENT_VISION_V1`, and no fresh human or artistic approval is claimed. Other Iris evaluating roles were not changed.

## Verification

- Ren'Py live-session fake-engine tests: 2 passed.
- `game_use` tool and narrative schema tests: 18 passed.
- Plugin, agent prompt, and plugin manifest tests: 55 passed, with one unrelated Windows `EPERM` symlink test in `plugin-manifest.test.ts`; the manifest assertion itself was updated for the new `web-build` rule.
- Scenario panel tests: 4 passed, including the matching-name default and the no-matching-run hint.
- `bun run typecheck`, `bun run lint`, `bun run plugin:check plugins/renpy`, `bun run build:host`, and `bun run build:renderer`: pass.
- The built desktop app was driven through CDP for the scenario discovery, two runs, exact checkpoint retrieval, comparison UI, live agent session, capture retention, and close.
- The application suite is recorded in the final mission report; the plugin-manifest suite has a known Windows symlink-environment failure unrelated to this change.

The app and direct SDK evidence above is actual Ren'Py 8.5.2 execution. The fake-engine tests are deterministic protocol and lifecycle coverage; they do not prove engine behavior.

## Limits

- No canonical game source, player save, persistent data, compiled artifact, or screenshot baseline was modified by the live adapter. The canonical Iris repair is the separate game-repository change.
- The live adapter does not expose game variables, arbitrary Python, shell commands, or generic desktop input.
- Project code still runs with the user's authority; custom save directories and absolute paths are not sandboxed. The copy is stronger isolation for the normal save path, not a filesystem sandbox.
- If the extension host is killed without disposal, an engine child may remain for separate cleanup.
- Live sessions are not retained as a permanent telemetry archive. Captures use the existing bounded conversation-image handling; the app does not fabricate a checkpoint id, HWND, observation grant, or desktop-capture identity for them.
- The app agent stopped before the other choice branch; that branch and later story are unverified. The `with` transition's exact timing is not established by still frames.
- The comparison UI can only compare images the app still retains; images evicted by the bounded budget remain metadata.
- Godot interactive playtesting, a universal action vocabulary, full cross-engine parity, and an upstream distribution change are not included.
- The interactive runtime is a development plugin integration, not an official upstream Ren'Py release.

## Evidence

External evidence is kept outside the OhMyGame repository at `H:\GithubRepositories\pilot-data\evidence\interactive-playtesting`:

- `app-live\conversation-live.json` — the two app-agent turns, tool calls, arguments, state results, and final reports.
- `app-live\captures\01-campus-walkway.jpg`, `02-sylvie-reveal.jpg`, `03-choice-consequence.jpg` — bounded app copies of the engine captures.
- `probe\probe.json`, `probe\choice.png` — the first direct module probe, including the stale-choice refusal and the choice frame.
- `probe-2\probe.json`, `probe-2\choice.png` — the transition/refusal/choice/stale-choice probe after the recovery fix.
- `app-scenario\engine-observations.json` — the two app scenario runs, checkpoint ids, sizes, and statuses.
- `app-scenario\comparison-ui.png` — the repaired comparison panel showing the same checkpoint name from both runs.
- `app-scenario\before-01-opening.png`, `after-01-opening.png`, `after-02-second.png` — exact checkpoints retrieved by id from the app.

The project used for the app exercise is `C:\Users\Admin\AppData\Local\Temp\opencode\renpy-app-probe`, a disposable copy of the SDK's `the_question` project with the `app_probe` testcase. The app's isolated data directory is `C:\Users\Admin\AppData\Local\Temp\opencode\ohmygame-interactive-app`.
