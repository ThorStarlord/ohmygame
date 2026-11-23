# Ren'Py integration in the ThorStarlord fork

**Status:** development plugin, not an upstream preinstalled plugin or a production-verified native integration.

The source lives at [plugins/renpy](../plugins/renpy/README.md). Install it in development mode through OhMyGame's Plugin UI; no changes to the upstream @ohmygame/godot package or preinstalled npm lock are needed.

## Scope delivered

- A proper Ren'Py project type, new-project template, and recognition of standard existing projects with game/options.rpy.
- SDK discovery from user configuration, RENPY_SDK_PATH, RENPY_HOME and PATH.
- Native Ren'Py CLI operations: lint --error-code, compile --keep-orphan-rpyc and interactive run.
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
