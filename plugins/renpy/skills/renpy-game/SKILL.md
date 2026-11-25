---
name: renpy-game
description: Build, edit, lint, compile, and preview Ren'Py visual novels with the user's locally installed Ren'Py SDK while preserving native .rpy projects.
---

# Ren'Py Game

Read the existing game/options.rpy, game/script.rpy, screens, labels, and asset layout before changing anything. Keep the installed Ren'Py version, Python compatibility, narrative structure, and save compatibility. Ren'Py is the runtime; OhMyGame's Interactive Story/Playable Nodes is a different format. Never silently convert the project to Playable Nodes.

## Engine and tests

1. Call renpy_status. If the SDK is missing, ask for a local Ren'Py SDK directory in the plugin settings or set RENPY_SDK_PATH / RENPY_HOME.
2. Edit .rpy and .py scripts with file tools. After edits, call renpy_lint. It uses --error-code, so an exitCode other than zero is a real failure; read the errors and repair introduced problems. Automated checks always run against a disposable mirror (`validationCopy: true`) that omits game/saves and game/cache and skips direct links into them. The normal player-save path is excluded; player data stored under another name or aliased through a nested root resource remains outside this protection. The mirror links root resources such as assets/, Canon/ and tests/, so project code can still read or write through those links with the user's authority.
3. Call renpy_compile when the changed script should be compiled. It runs with --keep-orphan-rpyc to preserve legacy compiled scripts and promotes changed or new .rpyc files back to the project; preserve those files across distributable builds because Ren'Py may depend on them to load older saves. Saves, cache and logs stay in the mirror.
4. If the game defines Ren'Py automated testcases, call renpy_test to execute them through the SDK and inspect failures. Tests run in the mirror; artifacts written under linked root directories can reach the project, while artifacts inside the mirror are discarded. Lint and test are different evidence. Use Run in Ren'Py for the native experience. The app's Game panel uses renpy_export_web to create a browser build from the mirror and promotes only the web output. Web support must first be installed in this SDK through the Ren'Py launcher. Do not assume that a native feature, video codec, Python package, or persistent-save behavior works in the browser.
5. Exercise a representative route with actual input and screenshots where available. Successful lint or build alone does not prove gameplay works.

## Art and code

Use OhMyGame's Canvas and Library to generate reusable concept art, sprites, backgrounds, voice, music and effects. Copy selected production files into the Ren'Py project (usually game/images/ and game/audio/) and reference their actual relative paths. Do not treat Canvas files as automatically imported by the engine. Keep art provenance and any required credits.

Protect original authorial choices, branching, translation keys, stable save data, and dialogue IDs. Do not rewrite story content just to demonstrate the toolchain.

## Web preview

The web build is produced from native Ren'Py by the local SDK using launcher web_build in the disposable mirror, not by translating .rpy into HTML or Playable Nodes. Only .ohmygame/build/web is promoted into the project. When Web support is missing, continue to use native lint, compile and Run in Ren'Py; report the missing export dependency instead of claiming the Game panel works.
