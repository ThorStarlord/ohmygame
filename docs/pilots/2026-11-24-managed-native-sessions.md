# Managed native engine sessions v1: Ren'Py and Godot

**Date:** 2026-11-24  
**Status:** bounded implementation and qualification complete; the app owns native engine sessions, Ren'Py adopts them, and Godot's pinned plugin waits on an external release.  
**OhMyGame:** `ThorStarlord/ohmygame`, branch `feat/managed-native-sessions`, based on `dev` `6148ab56`.  
**Atlas Midgard:** `main` `5aab42d03b16cb8467822f195a45daedb33c42cc` after the independent Larkspur repair.  
**Superhero-Netorare-Parody:** `main` `a604b5194b646818ef8d3c8bded4836492cd1bfd` after the Save/Load label repair.

## Verdict

| Question | Result |
| --- | --- |
| A native engine starts through a plugin and the launch call returns immediately | **PASS** |
| The host owns the process, reports state, and survives the former five-minute idle threshold | **PASS**, with real Ren'Py and Godot sessions |
| The previous Ren'Py 3600-second pending-command workaround is gone | **PASS** |
| A person or the owning project can stop a session deliberately | **PASS** |
| Normal exit, crash, failed launch, deactivation, project close, app shutdown, and host failure clean up | **PASS** in automated lifecycle tests |
| Another project cannot stop a session it does not own | **PASS** in automated tests; the real route returned 503 for a project without that host |
| Ren'Py lint, compile, tests, and Web export preserve protected player data | **PASS** for lint/compile/tests; Web export preserves save data but the installed SDK cannot produce complete Web output |
| Godot **Run in Godot** survives the host idle threshold with the pinned plugin | **FAIL/BLOCKED**: requires the upstream plugin change, a release, and a new OhMyGame pin |
| Full cross-platform qualification | **NOT_TESTED** |

## Architecture decision

The selected model is **host-owned managed native sessions**:

- The project's extension host spawns the engine executable.
- The host holds its own idle shutdown while a session runs, reusing the existing `hold()` mechanism, and releases the hold when the process ends.
- The host reports `starting`, `running`, `stopping`, `exited`, and `failed` states to the daemon.
- The daemon exposes the states to the project and forwards deliberate stops; it does not spawn or supervise engines itself.
- The launch command returns a session handle (`id`, `pid`, `label`, `stop()`, `exited`) instead of staying pending.
- One active session per plugin per project is enforced in the host.

Rejected alternatives:

- **Only extending the host hold**: a hold without a process record would keep the host alive but would not give observable state, deliberate stop, or crash cleanup.
- **A daemon-side generic supervisor**: duplicates the existing process-tree and host-lifetime machinery and creates a broader process surface.
- **Keeping the command pending**: the prior Ren'Py workaround coupled game lifetime to a command and needed an arbitrary 3600-second timeout.

Existing infrastructure reused:

- extension-host idle holds and pending-call cancellation;
- `process-lifecycle.ts` process-tree termination and crash registration;
- plugin activation/deactivation queues and project-host disposal;
- existing plugin capability grants (native plugins only).

## Implementation

| Area | Files |
| --- | --- |
| Shared contract and validation | `src/shared/native-sessions.ts`, `src/shared/extension-host-protocol.ts` (protocol v5, API 2.37.0) |
| Host process lifecycle | `src/daemon/extension-host-process.ts` |
| Daemon holds, state, stop, cleanup | `src/daemon/extension-hosts.ts`, `src/daemon/native-plugins.ts` |
| Routes | `src/daemon/app.ts` (`GET /projects/:id/native-sessions`, `POST /projects/:id/native-sessions/:id/stop`) |
| Renderer | `src/renderer/api.ts`, `src/renderer/project-shell.tsx`, `src/renderer/project-frame.tsx`, `src/renderer/project-frame.css`, EN/ZH locales |
| Ren'Py adoption | `plugins/renpy/native/index.mjs`, `plugins/renpy/native/renpy.mjs`, `plugins/renpy/.ohmygame-plugin/plugin.json` |
| Documentation | `docs/plugins.md`, `docs/renpy-integration.md`, `plugins/renpy/README.md` |

Contract notes:

- Plugin API version is `2.37.0`; the Ren'Py plugin requires `^2.37.0`.
- Native sessions are available only to project hosts, not app-wide hosts.
- `nativeSessionStartIssue()` bounds executable paths, arguments, working folder, and label, and rejects NUL bytes.
- Ended sessions remain in daemon state for 60 seconds; the project bar shows an ended session for 10 seconds.
- The Ren'Py `run-in-renpy` command no longer declares `timeoutSeconds`; bounded operations keep their own timeouts.

## Verification

### Automated checks

| Check | Result |
| --- | --- |
| `bun run test -- test/extension-hosts.test.ts test/renpy-plugin.test.ts test/project-frame.test.tsx test/godot-plugin.test.ts` | **90 passed, 2 skipped** (92 total) |
| Native-session lifecycle tests | **8 passed** |
| `bun run typecheck` | exit 0 |
| `bun run lint` | exit 0 |
| `bun run plugin:check plugins/renpy` | No problems found |
| `bun run plugin-api:check --base origin/dev` | Plugin API 2.37.0; `dev` released 2.36.0 |
| `bun run changelog:check` | exit 0 |
| `bun run build:host` | exit 0 |
| `bun run test -- test/project-plugins.test.ts test/godot-plugin.test.ts` | 34 passed, 1 failed: the pre-existing Windows `EPERM` symlink test |

The two skipped tests are platform-gated (`skipIf(process.platform === "win32")`).

The lifecycle tests cover: immediate return with a live process; a session keeping its host past an idle threshold; explicit stop; normal exit; unexpected exit code; failed executable with no leaked ownership; second-launch refusal; plugin deactivation; project host close; service shutdown; host crash; and cross-project stop refusal. One timing-sensitive test ("lets a plugin that is still activating clean up when its host stops") passed on the baseline and passed repeatedly alone; it failed twice under heavy parallel load and is recorded as an intermittent test, not a product failure.

### Real Ren'Py session

- SDK: Ren'Py `8.5.2.26010301`, isolated daemon on port 43210.
- Launch through `POST /projects/:id/plugin-commands` returned in **0.614 s** with `{ started: true, sessionId: "2c064286-a6a1-4bb8-b816-8bb6184e40a6", pid: 82788 }`.
- The session was observed **5 m 47 s** after launch, with the real game window "Evil get fucked!" open.
- `POST /projects/:id/native-sessions/:sessionId/stop` returned `{"stopped":true}`; the session reported `state: "exited"`, `exitCode: 0`, `stopped: true`, and the process was gone. Total lifetime was about 6 m 03 s.
- Plugin log recorded "Started native session Ren'Py (pid 82788)", "Stopping native session Ren'Py (pid 82788)", and "Native session Ren'Py exited (code 0)".
- Evidence: `H:\GithubRepositories\pilot-data\evidence\renpy-managed-launch2.log`, `renpy-managed-sessions2.json`, `renpy-managed-stop.log`, `renpy-managed-5min.png`, `renpy-plugin-log.json`.

### Real Godot session

- Engine: Godot `4.7.2.stable.official.ed1daf0bf`.
- The pinned `@ohmygame/godot` 1.0.3 was replaced in an isolated OhMyGame data directory with the forked source containing the managed-session change.
- **Run in Godot** returned in **4.09 s** with a running session, pid `78092`.
- The editor window showed `first_journey_title.tscn - Atlas: First Journey - Godot Engine` and remained open **5 m 30 s** after launch.
- Stop returned `{"stopped":true}`; the session reported `exitCode: 0`, `stopped: true`, and the process was gone.
- Evidence: `H:\GithubRepositories\pilot-data\evidence\godot-fork-run.log`, `godot-fork-sessions.json`, `godot-managed-5min.png`, `godot-managed-stop.log`.

### Cross-project ownership

With the Ren'Py session running, `POST /projects/<Atlas project>/native-sessions/<Ren'Py session>/stop` returned HTTP 503 ("The project's plugin host is not running"), and the Ren'Py session stayed running. The same check is enforced per host record in automated tests.

## Data safety

The protected fixture contained a valid `persistent` file and a real save slot copied from the **disposable pilot namespace**, not from the player's original full-game namespace. The original full-game data was not read or written during this qualification.

| File | Size | SHA-256 |
| --- | --- | --- |
| `persistent` | 1,948 | `f3e6b5c0da474c816d7c3273d32b9a60913f592d2d57658ec70f8ae726c2a62d` |
| `1-1-LT1.save` | 13,333 | `3a82be754e3faecb3b2990ec22d12ed37d21dd51efa026a4a4b62d3da99d0cf8` |

| Operation | Protected bytes | Exit | Notes |
| --- | --- | --- | --- |
| `lint --error-code` with `--savedir` | unchanged | 0 | Temporary savedir removed |
| `compile --keep-orphan-rpyc` with `--savedir` | unchanged | 0 | Temporary savedir removed |
| `launcher web_build` with `--savedir` and `RENPY_PATH_TO_SAVES` | unchanged | 1 | Package generation ran to 578 files; the installed SDK lacks complete Web assets (`WEB_PATH` is `None`) |
| Control: `lint` without `--savedir` in a disposable APPDATA | **changed** | 0 | Confirms the isolation is doing real work |

Why `RENPY_PATH_TO_SAVES` is required: `launcher web_build` starts the project in a child process that does not inherit the parent's `--savedir`. Without the environment override, the first fixture run rewrote the protected persistent file. The plugin now sets a temporary saves root and removes it on success, failure, and cancellation.

Generated files: Web export can leave `game/saves/` and `progressive_download.txt` inside the project. They are build artifacts, not the player's save namespace, and are deliberately not deleted automatically because a project without `config.save_directory` may legitimately use `game/saves`.

Remaining risk:

- The installed SDK cannot complete the final Web packaging step, so the full browser-export path is **NOT_TESTED**.
- `RENPY_PATH_TO_SAVES` behavior is verified against Ren'Py 8.5.2 on Windows only.
- Interactive **Run in Ren'Py** intentionally uses the project's configured save namespace; it is not isolated, and should not be described as validation-safe.

## Godot integration dependency

The pinned `@ohmygame/godot` 1.0.3 still starts the editor itself; its extension host can idle out after five minutes and kill the editor. Two independently useful upstream PRs are open from the permitted fork:

- [`WhiteTowerAI/ohmygame-plugins#62`](https://github.com/WhiteTowerAI/ohmygame-plugins/pull/62): add `include_filter=""` to the generated Web preset.
- [`WhiteTowerAI/ohmygame-plugins#63`](https://github.com/WhiteTowerAI/ohmygame-plugins/pull/63): use `context.nativeSessions` in **Run in Godot**, with the old spawn path as a fallback.

Both are `action_required` because this is a first-time contributor to that repository; maintainers must approve the runs. Delivering the fix to users additionally requires an upstream version bump, an npm release, and a new pin in `config/preinstalled-plugins.json`. No pinned artifact, npm package, or release was modified here.

## Independent game follow-ups

| Item | Result |
| --- | --- |
| Superhero PR #302 (duplicate "Page Page 1") | **MERGED** as `a604b5194b646818ef8d3c8bded4836492cd1bfd`; the only failing check was reproduced on pristine `main` and was not a required gate |
| Atlas Larkspur Morning repair | **MERGED** as PR #92, merge `5aab42d03b16cb8467822f195a45daedb33c42cc`, fix `3e549e330e51d200af29eec9cdf1ccbe5a3848c0` |

The Atlas repair uses the current split catalogs (`RegionalPreparationCatalog`, `CompanionPersonalStoryCatalog`, `CompanionRelationshipCatalog`) instead of restoring removed `ProgressionCatalog` members, and adds a scene-load regression for `larkspur_morning.tscn`.

## Evidence limitations

- The desktop UI shell was not automated end to end. The session chip has a focused component test, and the same HTTP routes the UI calls were exercised against real engines; no screenshot of the chip itself is claimed.
- OhMyGame's GitHub fork reported no actions checks for this branch; qualification relies on local commands and real-engine runs.
- Full OhMyGame suite, cross-platform CI, and the Godot 1.0.3 idle-stop scenario were not re-run beyond the evidence above.
- The pinned plugin's limitation remains a real product defect until the upstream release is available.
