# Ren'Py engine integration for OhMyGame

A development plugin for native Ren'Py visual novels. This lives in the user's OhMyGame fork, **not** in the upstream preinstalled plugin index. The official upstream Godot integration remains unchanged.

## Installation and first use

1. Install the Ren'Py SDK locally. Use the same SDK version your project expects; install **Web support** in the Ren'Py launcher to enable OhMyGame's browser Game panel.
2. Run the fork's OhMyGame desktop application. Open **Plugins → Add plugin → This computer**, enable **Develop**, and select this folder (the directory containing package.json). This development installation can be refreshed after edits.
3. Open plugin settings and choose the Ren'Py SDK directory, or set RENPY_SDK_PATH / RENPY_HOME in the environment inherited by OhMyGame.
4. Create a **Ren'Py game** project or import an existing project containing game/options.rpy. Existing projects with only a script.rpy can use a General project and enable the plugin manually.
5. Invoke renpy_status, renpy_lint and renpy_compile as appropriate; use **Run in Ren'Py** for the native game. The Game panel builds a Web export.

The starter template intentionally does not set a shared save-directory identifier; choose a unique stable one before shipping a game.\n\nThe plugin **does not bundle Ren'Py**, download an engine, translate .rpy files to Playable Nodes, or silently change existing game source. It only uses the user's chosen SDK.

## Project and preview contract

- Typed ID: thorstarlord/renpy:renpy-game
- Source format: normal Ren'Py project, game/options.rpy and .rpy scripts
- SDK resolution: explicit configured folder or launcher first; RENPY_SDK_PATH, RENPY_HOME and PATH next
- Windows CLI: lib/py3-windows-x86_64/python.exe renpy.py (or ARM64 interpreter if available)
- Unix CLI: renpy.sh
- Lint: project lint --error-code
- Compile: project compile --keep-orphan-rpyc (protects existing save compatibility)
- Native run: project run
- Web export: launcher web_build project --destination <staging>
- Browser Game panel: .ohmygame/build/web/index.html, promoted only after successful export (accepts flat and single nested distribution layouts)

Web export relies on SDK Web support and browser-compatible game features. Export may create/modify compiled .rpyc in the game tree; preserve these for Ren'Py save compatibility. A build that passes does not demonstrate scene behavior, media compatibility, or save behavior.

OhMyGame keeps project metadata in .ohmygame/, and its Canvas under canvas/. To make art, audio, and generated assets part of the Ren'Py game, copy selected files to game/images/ or game/audio/ and reference them from the .rpy scripts. Keep source files and licenses separately.

## Verification

Run the repository's plugin and source tests (after normal dependency setup):

    bun run plugin:check plugins/renpy
    bun run test -- test/renpy-plugin.test.ts

This test slice validates SDK discovery, manifest, command wiring, cancellation, output handling and transactional Web-export behavior with a fake CLI. It does not launch the real Ren'Py SDK. A Windows/macOS native smoke and browser input/audio/save qualification remain required before production claims.

## Engine authority

The Ren'Py command interface is documented at https://www.renpy.org/doc/html/cli.html . The CLI is not guaranteed stable across Ren'Py versions; validate your SDK version. Native and Web builds may have different capability envelopes.
