# Safe Ren'Py validation on a project with player saves

**Date:** 2026-11-25
**Status:** bounded capability implemented and qualified against the canonical Superhero-Netorare-Parody repository through the real extension host; the desktop dialog flow remains a separate UI check.
**OhMyGame:** `ThorStarlord/ohmygame`, branch `fix/renpy-validation-mirror`, based on `dev` `6be054172c39d7ee356fb668a272921c9ad4a2e6`; implementation commit `db680fe04cb545949371cf9cb16fad06840569e2`.
**Superhero-Netorare-Parody:** `ThorStarlord/Superhero-Netorare-Parody`, worktree at `work/m1-ch1-ch2-characterization-repair`; canonical source and player data were treated as read-only.

## Verdict

| Question | Result |
| --- | --- |
| Canonical project has real `game/saves` | **YES**: 30 files, 793,335 bytes |
| Previous automated lint/compile/test behavior | **BLOCKED** by the `game/saves` guard |
| New lint on the canonical project | **PASS as a run**: exit 1 with the project's pre-existing diagnostics, `validationCopy: true`, 18.7 s |
| Same lint through the real extension host | **PASS**: `renpy_lint` via `ExtensionHosts.invoke`, exit 1, `validationCopy: true`, 44.3 s, trees unchanged |
| Original player saves changed | **NO**: 30 files, digest `e1a30f2aedf3cddec258cbd785e5663e8114281b5897373ea5d1600515805f52` |
| Original `game` tree changed | **NO**: 666 files, digest `9c86d370a9367b29b82c5b1f8475d29376ef6c7c1eef3bd8fcafe550809adae0` |
| Original `state` tree changed | **NO**: 666 files, digest `246db173a83d1f3857429f2837b64798b3497f71fa592e826a41894161ab142e` |
| Original `Canon` and `assets` changed | **NO**: 1,309 and 821 files, same digests before and after |
| Disposable mirror removed | **YES** |
| Real compile promotion | **PASS on a disposable copy**: exit 0, `validationCopy: true`, 32 `.rpyc` files promoted, no `game/saves` created |
| Same compile through the real extension host | **PASS**: `renpy_compile` via `ExtensionHosts.invoke`, exit 0, 32 `.rpyc` promoted, 94.0 s, no saves created |

## Problem

Ren'Py always adds `<project>/game/saves` as an active save location. `--savedir` and `RENPY_PATH_TO_SAVES` do not redirect it. The plugin correctly refused to run automated lint, compile or test when that folder held player data, but the canonical Superhero project holds 30 save files. The project sets `config.save_directory`, but that does not remove Ren'Py's game-local location. The only prior workaround was to move the canonical saves aside, which the product did not offer and which would have risked player data.

## Capability

Every automated lint, compile and test runs in a disposable, project-shaped mirror:

- copies `game/` without `game/saves` or `game/cache`, matched case-insensitively;
- dereferences links inside `game/` so the mirror cannot link back to live player data;
- refuses a symbolic-link or non-directory `game/` or `state/` folder;
- copies writable root `state/`;
- links other root resources, including root junctions, so the game can resolve them;
- runs the SDK with the existing temporary `--savedir`, `RENPY_PATH_TO_SAVES`, `RENPY_MULTIPERSISTENT` and backup suppression;
- returns `validationCopy: true` with the raw exit code, output and diagnostics;
- promotes changed and new `.rpyc` files after a successful compile, with path and symlink checks;
- removes the mirror on success, failure or cancellation, reporting a cleanup warning instead of replacing the result.

Web export also builds from the mirror and promotes only `.ohmygame/build/web`, so a populated `game/saves` no longer blocks a preview. The launcher still writes its own SDK-launcher persistent data outside the project.

## Evidence

- Unit suite: `node node_modules/vitest/vitest.mjs run test/renpy-plugin.test.ts` and `bun run test -- test/renpy-plugin.test.ts` - 42 passed.
- Host-only suite: `bun run test -- test/extension-hosts.test.ts` - 62 passed, 2 skipped after `bun run prepare:preinstalled-plugins`. Earlier combined runs flaked in unrelated `native Browser requests` / `slowstart` timing tests; the affected single test and the final host-only suite passed.
- `bun run plugin:check plugins/renpy` - no problems.
- `bun run typecheck` and `bun run lint` - exit 0.
- Canonical lint: 18.7 s including the game and state copy, exit 1 with the project's existing Ren'Py diagnostics; saves, game, state, Canon and assets trees unchanged.
- Real compile on a disposable copy of the canonical project: exit 0, 32 `.rpyc` files promoted, no `game/saves` created, mirror removed.
- Canonical lint through the actual extension host: 44.3 s, `validationCopy: true`, exit 1, saves/game/state trees unchanged.
- Compile through the actual extension host on a disposable copy: 94.0 s, exit 0, 32 `.rpyc` files promoted, no `game/saves` created.
- Evidence logs: `H:\GithubRepositories\pilot-data\evidence\renpy-mirror-qualify-v6.json.log`, `renpy-host-qualify-v5.log`, and `renpy-host-compile-qualify-v5.log`. The host logs are local evidence, not a committed automated host test or remote CI run.

## Review findings addressed

An independent technical/security review of the earlier revision found blocking defects. This revision:

- refuses a symlinked or junction `game/` folder instead of mirroring through it;
- uses the mirror for every automated check, removing the in-place save cleanup and its time-of-check race;
- promotes compile artifacts so `renpy_compile` keeps its contract;
- excludes `game/SAVES` case-insensitively and skips case-variant root `Game`/`State` folders;
- skips direct links inside `game/` and at the root that resolve into saves, cache or state;
- handles root junctions and links root resources deliberately;
- makes cleanup failures warnings instead of replacement errors;
- preflights every compile-promotion target before reading, `mkdir` or writing, writes each replacement atomically, and rolls back already-promoted files on failure or cancellation;
- resolves a project opened through a junction to its real path before promotion;
- excludes only top-level `game/saves` and `game/cache`, preserving ordinary nested `cache`/`saves` asset folders;
- uses segment-aware path containment, so a save subdirectory such as `..backup` is still treated as inside saves while a legitimate `..name.rpyc` promotes;
- removes the populated-saves web-export refusal by building from the mirror;
- corrects the documentation claims from "read-only" and "never modified" to the actual path-based trust boundary.

## Limitations

- Root resources such as `assets/`, `Canon/`, `Sandbox/` and `tests/` are linked, not sandboxed. A project's own init code or test screenshots can write through those links with the user's authority.
- Save isolation is path-based. Player data kept under another name, or aliased through a nested link inside a linked root resource, is not detected and remains outside the guarantee.
- A project's `config.extra_savedirs` can still point outside the mirror; this pre-existing limitation must be handled explicitly by the project.
- The canonical lint and the disposable-copy compile were exercised through the real extension host and plugin tool path. The desktop project dialog, agent conversation, and Game panel were not automated; those remain a UI-level check.
- Compile through the extension host takes longer (36 to 94 s across runs on the canonical copy) because it copies the game and state trees before compiling. This is the safety cost, not a benchmark.
- Promotion is atomic per file and rolls back completed replacements. A cancellation that arrives during the final temp write or rename is not observed, and a process kill during the write phase can leave a mixed set.
- The installed Ren'Py SDK lacks complete Web support; real Web export and browser playtesting remain unqualified.
- Windows only in this run; macOS/Linux behavior, especially symlink handling, is not tested.
- The mirror copies the `game` tree and root `state`; large projects incur that cost per check, and cancellation waits for an in-progress copy.
- The lint exit code reflects the project's pre-existing diagnostics; this capability does not claim the game is clean.

## Next

Exercise the same lint/compile from the desktop project dialog, agent conversation and Game panel, add a user-visible validation action/status, then evaluate a shared engine-check/progress surface. The next product-level gap remains the absence of structured engine diagnostics and native visual observation, not the save guard itself.
