# Ren'Py integration in the ThorStarlord fork

**Status:** development plugin, not an upstream preinstalled plugin or a production-verified native integration.

The source lives at [plugins/renpy](../plugins/renpy/README.md). Install it in development mode through OhMyGame's Plugin UI; no changes to the upstream @ohmygame/godot package or preinstalled npm lock are needed.

## Scope delivered

- A proper Ren'Py project type, new-project template, and recognition of standard existing projects with game/options.rpy.
- SDK discovery from user configuration, RENPY_SDK_PATH, RENPY_HOME and PATH.
- Native Ren'Py CLI operations: lint --error-code, compile --keep-orphan-rpyc, automated Ren'Py testcases and an interactive run owned by OhMyGame's managed native-session lifecycle. Lint, compile, tests and Web export run with a throwaway `--savedir` plus redirected persistent state, because Ren'Py loads and can rewrite persistent data even for those operations. They refuse a project whose `game/saves` already holds player data, and remove saves an automated run creates. Interactive play intentionally uses the project's chosen save namespace.
- A web-build project type: web export to an isolated staging directory and promotion to .ohmygame/build/web only after an index.html exists in the output root or one unambiguous nested web distribution.
- Plugin project settings, localized names, tool schemas, a project-specific agent skill, and automated contract tests.

A plain General project can use the plugin without changing the project's native Ren'Py engine. Projects that do not contain game/options.rpy are not auto-recognized as Ren'Py; open them as General and enable the plugin.

## Architectural boundary

Ren'Py handles scripts, Python, screens, state, saves and distribution. OhMyGame provides coding agents, media generation, Canvas/Library, navigation and supported browser playtesting. Interactive Story / Playable Nodes is a separate runtime; no source conversion is performed.

A plugin is deliberately separate from the app core. In the current fork it is also deliberately **not preinstalled**: the managed preinstalled lock only contains reproducible pinned npm artifacts and upstream IDs. Adding a local development plugin to that lock as though it were published would break its checksum and origin security contract. Once a vetted plugin is published to a registry under an owned namespace, it could be pinned with a proper integrity value.

## Verification contract and remaining external gates

Repository-side tests in test/renpy-plugin.test.ts cover resolution on Windows-like and Unix-like layouts, command output and cancellation, rejection of unsafe output paths, export rollback, manifest validation and native hook registration. Run those in CI on supported OSes.

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
| `renpy_lint` | project `.rpyc`, `game/cache`, `log.txt`; `errors.txt` on failure | Temporary `--savedir`, `RENPY_PATH_TO_SAVES`, `RENPY_MULTIPERSISTENT`; backups disabled. Refuses a non-empty `game/saves`; removes a generated one. |
| `renpy_compile` | project `.rpyc`, `game/cache`, `log.txt` | Same isolation and `game/saves` guard as lint |
| `renpy_test` | whatever the project's tests write, plus `.rpyc`, cache, logs and test screenshots | Same isolation and `game/saves` guard; a test that saves uses the temporary savedir, not the player's namespace |
| Web export | `.ohmygame/build/web` after a valid `index.html`; `.rpyc`, cache, `log.txt`, `progressive_download.txt`; a generated `game/saves` is removed | Same isolation and `game/saves` guard. The launcher may still write its own `%APPDATA%\RenPy\persistent\launcher.renpy.org` and SDK-launcher saves. The installed SDK's Web support remains a separate qualification gate. |
| Run in Ren'Py | the game's own compiled files, cache and log | The game's real `config.save_directory` and, for a portable project, `game/saves`; this is deliberate play, not validation |
| Cancel/failure | staging and temporary savedirs are removed; a generated `game/saves` is removed | A pre-existing non-empty `game/saves` is never touched |

`--savedir` only replaces `config.savedir`. Ren'Py always adds `<project>/game/saves` as an active save location and writes persistent data to every active location. For a portable project without `config.save_directory`, Ren'Py ignores `RENPY_PATH_TO_SAVES` and `game/saves` is the real player namespace (`renpy.py` returns it before checking the environment). The plugin therefore checks `game/saves` before every automated operation: if it contains anything, the operation fails with an explanation instead of touching it; if it was absent or empty, the plugin removes what the run creates.

`RENPY_PATH_TO_SAVES` redirects the project persistent and save slots for a standard project. `RENPY_MULTIPERSISTENT` redirects MultiPersistent files, and `RENPY_DISABLE_BACKUPS` stops script backups. Ren'Py still writes `.rpyc`, cache and logs in the project; those are build artifacts, not player data. A project's own `config.extra_savedirs` are outside this guard: a project that points them at real player data must be moved or validated another way. A standard project whose `game/saves` already contains an older generated `persistent` is conservatively refused until that folder is moved aside. The installed 8.5.2 SDK had no complete Web assets, so the real Web-export output path remained unqualified even though package generation ran. Do not infer browser or save behavior from lint/compile.

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
