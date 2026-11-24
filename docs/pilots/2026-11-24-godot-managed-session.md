# Godot managed-session qualification: contributor plugin to real Atlas editor

**Date:** 2026-11-24  
**Status:** bounded fallback complete. The combined contributor plugin is installed as a **local development plugin** and verified against Atlas; no official Godot plugin release or OhMyGame pin change was made.  
**OhMyGame:** `ThorStarlord/ohmygame`, `dev` `64188c90f99ef960fc2aee42f369bdeda739b34a` at qualification start; final `dev` after this report merged is `bddd1a6d2d80c7cfd1d7ec74fe33922733e576be`.  
**Official plugin repository:** `WhiteTowerAI/ohmygame-plugins`, `main` `28a78812bb86bd07ac93b754c79c40ebd5e51a4a`.  
**Integrated contributor source:** `ThorStarlord/ohmygame-plugins`, branch `combined/godot-managed-web` at `3c696e8b9477bc9fb1ec41bd9d93c31ef833b117`.  
**Atlas Midgard:** `main` `5aab42d03b16cb8467822f195a45daedb33c42cc`; qualification used a disposable worktree with a private Godot user-directory setting.

## Verdict

| Question | Result |
| --- | --- |
| PR #63 uses a managed native session when the host supports it | **PASS** |
| PR #63 keeps a feature-detected older-host fallback and does not claim managed ownership there | **PASS** |
| PR #62 writes `include_filter=""` into a generated Web preset | **PASS** |
| Both changes integrate cleanly on current upstream `main` | **PASS** |
| Plugin typechecks against current OhMyGame `dev` | **PASS** |
| Real Atlas editor launches through OhMyGame | **PASS**, 4.44 s |
| Editor and managed session survive the former five-minute idle threshold | **PASS**, observed at 6 m 46 s; ended at 7 m 09 s |
| Explicit Stop ends the correct process tree | **PASS**, 2.11 s, exit code 0 |
| Project closure ends its owned session | **PASS**, editor 77152 gone |
| Repeat launch after Stop/closure | **PASS**, 1.44 s and 3.55 s |
| Host returns to ordinary idle behavior after the last Stop | **PASS**, host 88284 exited after the idle window |
| Web export no longer logs the missing `include_filter` key | **PASS**, exit 0; no such warning |
| Official upstream merge, release, and OhMyGame pin | **BLOCKED**: read-only upstream permission and no new published package |

## Starting state

- OhMyGame fork `dev`: `64188c90` (managed sessions and Ren'Py safety corrections merged).
- Upstream plugin `main`: `28a78812`.
- PR #63 head before this work: `3afc76f`; after adding cancellation/fallback tests: `c3951de`.
- PR #62 head: `445cbc1`.
- Published Godot plugin: npm `@ohmygame/godot@1.0.3`; GitHub tag `godot-v1.0.3`; no newer version.
- Upstream repository permission for this account: `pull: true`, `push: false`; both PRs have no reviews and no check runs.
- Atlas `main`: `5aab42d`; its canonical worktree has owner changes and was not modified.
- Godot: `4.7.2.stable.official.ed1daf0bf`.

## Upstream qualification

### PR #63 — managed editor session

The change uses `context.nativeSessions.start` only when present, with:

- the configured Godot executable;
- `--path <project> --editor`;
- the project as working directory;
- label `Godot`;
- an immediate return after launch;
- `session.stop()` if the call is cancelled while the session starts;
- the existing spawn + `onDispose` path when `context.nativeSessions` is absent.

The manifest remains on `engines["ohmygame-api"] = "^2.35.0"`, which matches the fallback: older hosts still run the editor with the old lifetime behavior and do not receive managed-session guarantees. The new tests cover managed launch, cancellation during start, and the older-host fallback.

### PR #62 — Web preset

The generated preset now contains:

```ini
include_filter=""
```

The real qualification generated a Web preset in an Atlas checkout that previously had only a Windows preset. The export completed with exit 0, and its output contained no `include_filter` or “Couldn't find the given section” warning.

### Combined integration

The two diffs apply cleanly to current upstream `main` and are published together on the contributor fork as `combined/godot-managed-web` (`3c696e8`). The plugin packages successfully with the upstream release packer: 28,799-byte ZIP, manifest `ohmygame/godot` `1.0.3`, all expected package files.

## Distribution decision

**Selected: Option C, local development-plugin installation.**

| Option | Decision |
| --- | --- |
| A — signed GitHub release | **Deferred.** OhMyGame's signed-release loader exists, but the app ships no trusted publisher keys (`pluginReleaseKeys` defaults to empty) and there is no signed Godot release record. There is nothing legitimate to verify or install. Adopting the upstream preinstalled-release migration would be unrelated, larger work. |
| B — npm release | **Unavailable.** npm's latest `@ohmygame/godot` is still `1.0.3` with the existing tarball integrity. No new package exists, and publishing would require `@ohmygame` authority. |
| C — local development plugin | **Used.** The combined source was installed in an isolated OhMyGame data directory through the supported directory-development workflow. |

The installed plugin is explicitly a development origin, not an official or preinstalled release:

- plugin: `ohmygame/godot`, version `1.0.3`;
- origin: `development`, folder `H:\GithubRepositories\ohmygame-plugins-combined\plugins\godot`;
- source commit: `3c696e8b9477bc9fb1ec41bd9d93c31ef833b117`;
- installed-package digest: `4f4e052d93c04dafd479dc6c0651dd9feec59fd47f1d5b80fe00ba6d0ce571c5`;
- installed `native/index.mjs` contains both `include_filter=""` and the `context.nativeSessions` branch;
- the pinned `@ohmygame/godot` 1.0.3 tarball remains byte-identical to `config/preinstalled-plugins.json` (`sha512-DibLwHJ3…`).

## Real Atlas verification

### Isolation

The disposable worktree is `H:\GithubRepositories\atlas-godot-mission` at Atlas `5aab42d`. It adds only test isolation to `project.godot`:

```ini
config/use_custom_user_dir=true
config/custom_user_dir_name="atlas-ohmygame-godot-20261124"
```

The canonical Godot user directory `Atlas- First Journey` had its pre-existing timestamp and was not written during this run. No canonical Atlas source was changed.

### Lifecycle

| Event | Evidence |
| --- | --- |
| Launch through `run-in-godot` | returned in **4.44 s**, `{ "started": true }` |
| Session | `3fa92e86-bb00-4df7-8252-005d73cea67f`, pid `86344`, state `running` |
| Editor | `Godot_v4.7.2-stable_win64.exe --path H:\GithubRepositories\atlas-godot-mission --editor` |
| Window | `first_journey_title.tscn - Atlas: First Journey - Godot Engine` |
| Idle qualification | observed at **6 m 03 s** and **6 m 46 s** after launch; screenshot shows the editor and project |
| Explicit Stop | HTTP 200 `{"stopped":true}` in **2.11 s** |
| Exit | `state: "exited"`, exit code 0, `stopped: true`; pid 86344 gone |
| Total first session | **7 m 09 s** |
| Second launch | returned in **1.44 s**, pid `77152`; project close stopped it and pid 77152 was gone |
| Third launch after reopen | returned in **3.55 s**, pid `84648`; Stop exited code 0, pid gone |
| Host idle | extension-host pid `88284` exited after the idle window; no Godot mission process remains |

Evidence screenshots and logs are under `H:\GithubRepositories\pilot-data\evidence\`:

- `godot-mission-editor-6min.png` (real editor, 6 m 46 s);
- `godot-mission-launch.log`, `godot-mission-sessions-running.json`;
- `godot-mission-sessions-5min.json`, `godot-mission-plugin-log-5min.json`;
- `godot-mission-stop.log`, `godot-mission-sessions-stopped.json`;
- `godot-mission-launch2.log`, `godot-mission-project-close.log`, `godot-mission-plugin-log-close.json`;
- `godot-mission-launch3.log`, `godot-mission-stop3.log`, `godot-mission-sessions-third-stopped.json`;
- `godot-mission-web-export.json`, `godot-mission-web-export-run.log`.

### Web preset regression

The first export had no Web preset (`hadWebPresetBefore: false`). It added:

```ini
[preset.1]
name="Web"
platform="Web"
include_filter=""
export_path=".ohmygame/build/web/index.html"
```

Result: exit 0 in 15.99 s, `hasWebPresetAfter: true`, `includeFilterAdded: true`, `missingIncludeFilterWarning: false`. The build produced `index.html`, `index.js`, `index.pck`, `index.wasm`, and sidecars.

The export log also contains pre-existing Atlas script errors unrelated to this plugin:

- `SAGA_FEAST_WITHOUT_END` missing from `ProgressionCatalog`;
- `RAVENOUS` missing from `EncounterCatalog`;
- `civic_stabilization_area.gd` failing to load.

These are inherited game-source defects; the canonical Atlas tree and game content were not modified.

## Test evidence

### Plugin repository

- `npm run typecheck` against upstream OhMyGame `dev`: **exit 0**.
- Focused `test/godot.test.ts`: **6 passed, 1 failed**. The failure is the pre-existing `templatesFolder` path assertion on Windows (`/home/me/...` versus `\home\me\...`); it reproduces on pristine `28a78812`.
- Full `npm test`: **273 passed, 7 failed, 1 skipped**. The seven failures are Windows/environment-only: the same path-separator assertion, CRLF-sensitive Tiled JSON, an `EPERM` rename, a Unix executable-bit check, two missing `ffmpeg-static` binaries, and a Sketchfab local-auth status mismatch. None touches the changed Godot managed-session or preset code; the Godot official-plugin test passes.
- Release packaging: **exit 0**, 28,799-byte ZIP; manifest and expected files verified.

### OhMyGame fork

- `bun run test -- test/extension-hosts.test.ts test/godot-plugin.test.ts test/project-frame.test.tsx test/preinstalled-plugins.test.ts`: **104 passed, 2 skipped**.
- `bun run typecheck`, `bun run lint`: exit 0.
- `bun run plugin-api:check --base origin/dev`: Plugin API 2.37.0; `dev` released 2.37.0.
- The preinstalled Godot tarball hash equals the lock entry; the pin was not changed.

## Remaining dependency

An upstream maintainer with write access must:

1. Review and merge PR #63 and PR #62.
2. Bump `plugins/godot/package.json` and `.ohmygame-plugin/plugin.json` to a new version.
3. Let the publish workflow create the new `godot-v<version>` GitHub release (or publish a new npm package through the `@ohmygame` organization).
4. Update OhMyGame's distribution lock for that exact released artifact:
   - for npm, the new tarball's SHA-512 integrity;
   - for signed GitHub releases, a trusted publisher key and catalog record.
5. Re-run the pinned-plugin editor-lifetime qualification.

The current pinned 1.0.3 still starts the editor itself and can still be ended by the project host's idle timeout. Only the local development installation contains the verified managed-session behavior.

## Evidence limitations

- The OhMyGame desktop shell was not automated end to end; the daemon HTTP routes and the real native session were exercised, and the session-chip component/API tests pass.
- The local development install is not an official release and is not represented as one.
- The Atlas Web export's exit code was 0, but its log retained inherited script errors; it is not a clean game-quality qualification.
- Full cross-platform CI was not available; Windows-specific failures are classified above.

## Next recommendation

Complete the official distribution chain: merge the two upstream PRs, publish one new Godot plugin version, update the OhMyGame lock with the exact released bytes, and repeat this same Atlas launch/idle/Stop qualification against the installed released plugin.
