# Ren'Py engine integration for OhMyGame

A development plugin for native Ren'Py visual novels. This lives in the user's OhMyGame fork, **not** in the upstream preinstalled plugin index. The official upstream Godot integration remains unchanged.

## Installation and first use

1. Install the Ren'Py SDK locally. Use the same SDK version your project expects; install **Web support** in the Ren'Py launcher to enable OhMyGame's browser Game panel.
2. Run the fork's OhMyGame desktop application. Open **Plugins → Add plugin → This computer**, enable **Develop**, and select this folder (the directory containing package.json). This development installation can be refreshed after edits.
3. Open plugin settings and choose the Ren'Py SDK directory, or set RENPY_SDK_PATH / RENPY_HOME in the environment inherited by OhMyGame.
4. Create a **Ren'Py game** project or import an existing project containing game/options.rpy. Existing projects with only a script.rpy can use a General project and enable the plugin manually.
5. Invoke renpy_status, renpy_lint and renpy_compile as appropriate; use **Run in Ren'Py** for the native game. The Game panel builds a Web export.

The starter template intentionally does not set a shared save-directory identifier; choose a unique stable one before shipping a game.

The plugin **does not bundle Ren'Py**, download an engine, translate .rpy files to Playable Nodes, or silently change existing game source. It only uses the user's chosen SDK.

## Project and preview contract

- Typed ID: thorstarlord/renpy:renpy-game
- Source format: normal Ren'Py project, game/options.rpy and .rpy scripts
- SDK resolution: explicit configured folder or launcher first; RENPY_SDK_PATH, RENPY_HOME and PATH next
- Windows CLI: lib/py3-windows-x86_64/python.exe renpy.py (or ARM64 interpreter if available)
- Unix CLI: renpy.sh
- Lint: --savedir <temporary> <mirror> lint --error-code, with a temporary RENPY_PATH_TO_SAVES and RENPY_MULTIPERSISTENT and backups disabled
- Engine testcases: --savedir <temporary> <mirror> test (requires the game to define Ren'Py tests), with the same isolation
- Compile: --savedir <temporary> <mirror> compile --keep-orphan-rpyc; changed and new .rpyc files are promoted back to the project, while saves and cache stay in the mirror
- Native run: project run through OhMyGame's managed native session (the host owns the process; the command returns immediately; stop from the project top bar)
- Web export: --savedir <temporary> launcher web_build <mirror> --destination <staging>, with the same isolation inherited by the launcher's project process
- Browser Game panel: .ohmygame/build/web/index.html, promoted only after successful export (accepts flat and single nested distribution layouts)

Web export relies on SDK Web support and browser-compatible game features. Only the finished web folder is promoted; compiled files and cache produced during the export stay in the mirror. Run renpy_compile when the project's own .rpyc files must be refreshed for save compatibility. A build that passes does not demonstrate scene behavior, media compatibility, or save behavior.

## Player data

Ren'Py always treats `game/saves` as an active save location, and for a portable project without `config.save_directory` it is the real player namespace. `--savedir` and `RENPY_PATH_TO_SAVES` do not redirect it. Automated lint, compile and engine-test operations therefore always run against a disposable project-shaped copy. The copy leaves out `game/saves` and `game/cache` (matched case-insensitively), copies writable root `state/`, and links other root resources so the game can resolve them. Direct links that resolve into `game/saves`, `game/cache` or `state/` are skipped, and saves the run creates stay in the mirror. Compile promotes changed and new `.rpyc` files back to `game/`; lint and tests promote nothing. Web export also builds in the mirror and promotes only `.ohmygame/build/web`, so a project with real player saves can still produce a preview. Interactive **Run in Ren'Py** deliberately uses the project's real save namespace.

The protection is path-based. A project that keeps player data under another name, aliases it through a path the mirror does not recognize, or nests such a link inside a linked root resource remains outside the mirror's guarantees. Project code and tests can read or write those paths, and linked root resources, with the user's authority. The normal `game/saves` path is excluded from the mirror.

Linked root resources such as `assets/`, `Canon/` or `tests/` are not sandboxed: a project's own init code or test screenshots can write through those links with the user's authority. A project that points `config.extra_savedirs` at real player data remains outside this isolation. The mirror excludes `.git`, `.ohmygame`, `build`, `dist`, `node_modules`, `.venv`, caches and `.tmp`; it copies the whole `game/` tree and root `state/`, so large projects pay that cost on each automated check. Cancellation stops the SDK process, but an in-progress copy finishes before the call returns. A process crash can leave a mirror behind, or leave a promotion partially applied; normal cleanup reports a locked folder as a warning.

OhMyGame keeps project metadata in .ohmygame/, and its Canvas under canvas/. To make art, audio, and generated assets part of the Ren'Py game, copy selected files to game/images/ or game/audio/ and reference them from the .rpy scripts. Keep source files and licenses separately.

## Verification

Run the repository's plugin and source tests (after normal dependency setup):

    bun run plugin:check plugins/renpy
    bun run test -- test/renpy-plugin.test.ts

This test slice validates SDK discovery, manifest, command wiring, cancellation, output handling, the disposable validation copy, save exclusion, compile-artifact promotion, Web export from the mirror, and transactional preview behavior with a fake CLI. It does not launch the real Ren'Py SDK by default. A Windows/macOS native smoke and browser input/audio/save qualification remain required before production claims. Lint, compile and engine tests use a throwaway `--savedir` plus redirected persistent state, because Ren'Py loads and can rewrite persistent data during those checks.

## Engine authority

The Ren'Py command interface is documented at https://www.renpy.org/doc/html/cli.html . The CLI is not guaranteed stable across Ren'Py versions; validate your SDK version. Native and Web builds may have different capability envelopes.
