# Ren'Py integration in the ThorStarlord fork

**Status:** development plugin, not an upstream preinstalled plugin or a production-verified native integration.

The source lives at [plugins/renpy](../plugins/renpy/README.md). Install it in development mode through OhMyGame's Plugin UI; no changes to the upstream @ohmygame/godot package or preinstalled npm lock are needed.

## Scope delivered

- A proper Ren'Py project type, new-project template, and recognition of standard existing projects with game/options.rpy.
- SDK discovery from user configuration, RENPY_SDK_PATH, RENPY_HOME and PATH.
- Native Ren'Py CLI operations: lint --error-code, compile --keep-orphan-rpyc, automated Ren'Py testcases and an interactive run owned by OhMyGame's managed native-session lifecycle. Lint, compile and tests always run against a disposable project-shaped mirror with a throwaway `--savedir` plus redirected persistent state, because Ren'Py loads and can rewrite persistent data even for those operations. The mirror omits `game/saves` and `game/cache`, copies root `state/`, links other root resources, and skips direct links that resolve into saves, cache or state. Compile promotes changed and new `.rpyc` files back to the project; lint and tests promote nothing. The protection is path-based: player data under another name, or aliased through a nested linked root resource, remains outside these guarantees. Web export builds in the same mirror and promotes only the finished web folder. Interactive play intentionally uses the project's chosen save namespace.
- A web-build project type: web export from the mirror to an isolated staging directory and promotion to .ohmygame/build/web only after an index.html exists in the output root or one unambiguous nested web distribution.
- Plugin project settings, localized names, tool schemas, a project-specific agent skill, and automated contract tests.

A plain General project can use the plugin without changing the project's native Ren'Py engine. Projects that do not contain game/options.rpy are not auto-recognized as Ren'Py; open them as General and enable the plugin.

## Architectural boundary

Ren'Py handles scripts, Python, screens, state, saves and distribution. OhMyGame provides coding agents, media generation, Canvas/Library, navigation and supported browser playtesting. Interactive Story / Playable Nodes is a separate runtime; no source conversion is performed.

A plugin is deliberately separate from the app core. In the current fork it is also deliberately **not preinstalled**: the managed preinstalled lock only contains reproducible pinned npm artifacts and upstream IDs. Adding a local development plugin to that lock as though it were published would break its checksum and origin security contract. Once a vetted plugin is published to a registry under an owned namespace, it could be pinned with a proper integrity value.

## Verification contract and remaining external gates

Repository-side tests in test/renpy-plugin.test.ts cover resolution on Windows-like and Unix-like layouts, command output and cancellation, rejection of unsafe output paths, the disposable mirror and save exclusion, compile-artifact promotion, export rollback, manifest validation and native hook registration. Run those in CI on supported OSes.

The following remains a separate end-to-end qualification and must not be inferred from unit tests:

1. Install the Ren'Py SDK on a real Windows desktop and configure this plugin.
2. Create a new project and import an existing game, confirming original files and saves are preserved.
3. Edit a .rpy file using an OhMyGame-backed coding agent; lint and compile it.
4. Launch the real native Ren'Py game and validate audio, input, dialogue and existing saves.
5. Install matching Ren'Py Web support, run the web build, inspect the Game panel and verify media, interaction, storage and error handling.
6. Change a script, rebuild, and confirm updates. Introduce a web-build failure, confirm the previous successful preview remains available, and remove the fault.
7. Exercise agent gameplay input/capture in the rendered web build. An automated screenshot requires the game_use desktop test environment.

### Data safety

| Operation | May change | Player data |
| --- | --- | --- |
| `renpy_lint` | no promoted files; generated `.rpyc`, `game/cache` and logs stay in the mirror | Temporary `--savedir`, `RENPY_PATH_TO_SAVES`, `RENPY_MULTIPERSISTENT`; backups disabled. The disposable mirror omits `game/saves` and `game/cache`; linked root resources remain writable by the project's own code. |
| `renpy_compile` | changed and new project `.rpyc` files are promoted from the mirror; `game/cache` and logs stay in the mirror | Same mirror and temporary save state as lint. Every target is preflighted before any read or write: paths outside `game/`, symbolic-link targets and non-file targets are refused before a directory is created. Each replacement is written to a same-directory temporary file and renamed, so a failed copy does not truncate the existing `.rpyc`; a write failure or cancellation rolls back files already promoted. A process kill during the short write phase can still leave a mixed set. |
| `renpy_test` | whatever the project's tests write inside the mirror; artifacts under linked root directories can reach the project | Same mirror; a test that saves uses the temporary savedir, not the player's namespace |
| Web export | `.ohmygame/build/web` after a valid `index.html`; compiled files, cache and `progressive_download.txt` stay in the mirror | The launcher builds from the mirror, so a populated `game/saves` no longer blocks export. The launcher may still write its own `%APPDATA%\RenPy\persistent\launcher.renpy.org` and SDK-launcher saves. The installed SDK's Web support remains a separate qualification gate. |
| Run in Ren'Py | the game's own compiled files, cache and log | The game's real `config.save_directory` and, for a portable project, `game/saves`; this is deliberate play, not validation |
| Cancel/failure | staging, temporary savedirs and the disposable mirror are removed | No original save cleanup runs. A locked cleanup leaves a warning instead of replacing the check result. |

`--savedir` only replaces `config.savedir`. Ren'Py always adds `<project>/game/saves` as an active save location and writes persistent data to every active location. For a portable project without `config.save_directory`, Ren'Py ignores `RENPY_PATH_TO_SAVES` and `game/saves` is the real player namespace (`renpy.py` returns it before checking the environment). Every automated operation therefore runs against a disposable mirror. The mirror excludes `game/saves` and `game/cache` case-insensitively, refuses a symbolic-link `game/` or `state/` folder, copies root `state/`, links other root resources, and skips direct links that resolve into saves, cache or state. Saves Ren'Py creates during the run stay in the mirror. The exclusion is name- and direct-link-based, not a filesystem sandbox: a project that stores player data under another name, or nests an alias inside a linked root resource, can still read or write it with the user's authority.

`RENPY_PATH_TO_SAVES` redirects the project persistent and save slots for a standard project. `RENPY_MULTIPERSISTENT` redirects MultiPersistent files, and `RENPY_DISABLE_BACKUPS` stops script backups. Ren'Py writes `.rpyc`, cache and logs in the mirror; only compile deliberately promotes `.rpyc`. Linked root resources such as `assets/`, `Canon/`, `Sandbox/` and `tests/` are not sandboxed and can be written through by project code or tests with the user's authority. A project's own `config.extra_savedirs` are also outside this isolation: a project that points them at real player data must be validated another way; the disposable copy preserves those configured paths. The mirror excludes `.git`, `.ohmygame`, `build`, `dist`, `node_modules`, `.venv`, caches and `.tmp`, so a project that reads those from its game scripts may behave differently. Copying the full `game/` tree and root `state/` costs time on large projects, and cancellation waits for an in-progress copy before the SDK process stops. The installed 8.5.2 SDK had no complete Web assets, so the real Web-export output path remained unqualified even though package generation ran. Do not infer browser or save behavior from lint/compile.

The Ren'Py CLI is version-sensitive and web builds have feature restrictions. See https://www.renpy.org/doc/html/cli.html and https://www.renpy.org/doc/html/web.html for the engine's current authority.

## Godot qualification

Godot is already an official preinstalled plugin at @ohmygame/godot 1.0.3, maintained separately in WhiteTowerAI/ohmygame-plugins. Its manifest supports Godot project recognition, headless validation, web build, Run in Godot and an MCP server.

The fork's test/godot-plugin.test.ts tests installation discovery and pins Godot's project recognition, Web-build type and AI-tool contract. Upstream plugin tests cover web template handling. The plugin agent skill explicitly states that Godot MCP does not capture viewport or input, while the exported browser build can support OhMyGame web playtesting.

A full Godot release-ready claim requires a real Godot 4.3+ editor, the Compatibility renderer, matching web export templates, a representative project, and native/web gameplay verification. Do not change the upstream @ohmygame/godot code without a reproducible defect.

## Owner decisions captured

- Preserve each engine's own project format and source-of-truth runtime.
- Prefer a separate Ren'Py plugin over duplicating core OhMyGame functionality.
- Implement the useful native development vertical and guarded web export, without pretending simulated tests qualify a real desktop.
- Treat autopublish, upstream package publication and unverified engine behavior as out of scope for this fork.
