# Safe Ren'Py validation on a project with player saves

**Date:** 2026-11-25  
**Status:** bounded capability complete and qualified against the canonical Superhero-Netorare-Parody repository; desktop UI/daemon adoption remains a separate integration step.  
**OhMyGame:** `ThorStarlord/ohmygame`, branch `fix/renpy-validation-mirror`, based on `dev` `6be054172c39d7ee356fb668a272921c9ad4a2e6`; candidate `736610d73d39ad03bb4d73d2a3c57993b60542ea`.  
**Superhero-Netorare-Parody:** `ThorStarlord/Superhero-Netorare-Parody`, worktree at `work/m1-ch1-ch2-characterization-repair`; canonical source and player data were treated as read-only.

## Verdict

| Question | Result |
| --- | --- |
| Canonical project has real `game/saves` | **YES**: 30 files, 793,335 bytes |
| Previous automated lint/compile/test behavior | **BLOCKED** by the `game/saves` guard |
| New lint on the canonical project | **PASS as a run**: exit 1 with the project's pre-existing diagnostics, `validationCopy: true` |
| New compile on the canonical project | **PASS**: exit 0, `validationCopy: true` |
| Original player saves changed | **NO**: 30 files, tree digest `e1a30f2aedf3cddec258cbd785e5663e8114281b5897373ea5d1600515805f52` |
| Original `game` tree changed | **NO**: byte-identical tree comparison before/after |
| Original `state` tree changed | **NO**: 666 files, tree digest `246db173a83d1f3857429f2837b64798b3497f71fa592e826a41894161ab142e` |
| Disposable mirror removed | **YES**, including after the compile run |
| Web export with populated saves | **STILL REFUSED**, because its output belongs to the original project |

## Problem

Ren'Py always adds `<project>/game/saves` as an active save location. `--savedir` and `RENPY_PATH_TO_SAVES` do not redirect it. The plugin correctly refused to run automated lint, compile or test when that folder held player data, but the canonical Superhero project does hold 30 save files. The project sets `config.save_directory`, but that does not remove Ren'Py's game-local location. The only prior workaround was to move the canonical saves aside, which the product did not offer and which would have risked player data.

## Capability

`runWithIsolatedSaves` now creates a disposable, project-shaped validation mirror when `game/saves` is non-empty:

- copies `game/` without `game/saves` or `game/cache`;
- copies writable root `state/`;
- links other root resources read-only (`assets/`, `Canon/`, `Sandbox/`, and similar project context);
- runs the SDK with the existing temporary `--savedir`, `RENPY_PATH_TO_SAVES`, `RENPY_MULTIPERSISTENT` and backup suppression;
- returns `validationCopy: true` with the raw exit code, output and diagnostics;
- removes the mirror on success, failure or cancellation.

A project without populated `game/saves` still validates in place exactly as before, with a temporary savedir and removal of saves the run creates. Web export still refuses populated saves because it must promote a build into the original project.

## Evidence

- Unit suite: `bun run test -- test/renpy-plugin.test.ts` — 27 passed (also passes under Node).
- Host lifecycle suite: `bun run test -- test/renpy-plugin.test.ts test/extension-hosts.test.ts` — 89 passed, 2 skipped.
- `bun run plugin:check plugins/renpy` — no problems.
- `bun run typecheck` and `bun run lint` — exit 0.
- Real lint: 11.9 s including copy, exit 1 with the project's existing Ren'Py diagnostics; no missing root file.
- Real compile: exit 0, no missing root file.
- Save/game/state tree hashes before and after: unchanged; mirror removed.
- Evidence log: `H:\GithubRepositories\pilot-data\evidence\renpy-mirror-qualify-final.json.log`.

## Limitations

- Other root resources are linked read-only, not sandboxed. A project's own init code could write through a linked root path; the mirror protects player saves and copied `state`, not every arbitrary filesystem write. Ren'Py project code already runs with the user's authority.
- A project's `config.extra_savedirs` can still point outside the mirror; this pre-existing limitation is unchanged and must be handled explicitly by the project.
- The canonical project was exercised through the plugin's native module, not through the desktop daemon or extension host. The Agent/UI path still needs an integration run.
- The installed Ren'Py SDK lacks complete Web support; Web export/browser playtesting remains unqualified.
- Windows only in this run; macOS/Linux mirror behavior is not tested.
- The validation mirror copies the `game` tree and root `state`; large projects incur that copy cost per check. A future cache could reduce repeated copies, but correctness was prioritized first.
- The lint exit code reflects the project's pre-existing diagnostics; this capability does not claim the game is clean.

## Next

Run the same lint/compile through the actual OhMyGame extension host and project route on a disposable project, add a user-visible validation action/status, then evaluate a shared engine-check/progress surface. The next product-level gap remains the absence of structured engine diagnostics and native visual observation, not the save guard itself.
