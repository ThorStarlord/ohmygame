# Autonomous gameplay investigation v1: scenario-directed managed playtesting

**Date:** 2026-11-28
**Status:** Atlas candidate `feat/dev-scenario-entry`, draft PR #96 stacked on
PR #95/#94/#93; not merged into canonical `main`, not human-qualified.
OhMyGame documentation and regression coverage merged into `dev`.

**OhMyGame:** `ThorStarlord/ohmygame`, `dev` at
`40c1aa0febba9f78116082c2e039cc5d86b59a04` (after PR #28 and #29).
**Atlas Midgard:** canonical `main`
`5aab42d03b16cb8467822f195a45daedb33c42cc`; PR #93 `2e8d6e8`; PR #94
`6a150e4`; PR #95 `4ffa931`; PR #96 `3cf32e2` (code `4fdab48`, docs
`3cf32e2`).
**Preserved:** Superhero-Netorare-Parody #355 `e84b6122`, #363 `23b7f084`,
#364 `270150dc`; unchanged.

## What this mission asked

Enable an agent to formulate a gameplay investigation, reach the context,
exercise alternatives, observe consequences, reason about the experience and
improve the game. Use the Warden-Castellan progression as the responsibility,
and advance OhMyGame's managed gameplay investigation and revision-bound
evidence.

## Starting reconciliation

The Episode 15 pilot summary said the final journey recorded the Warden mark;
the detailed evidence said it did not. The `d7a6a06` journey indeed did not.
The final `9f92c7d` journey **does** record `enemy_command_mark` at tick 906
(target `Player`, two empowered Reavers), and the focused real-scene test
independently verifies the mark. The summary was corrected in PR #28, and the
new evidence is recorded here. The earlier run is not retroactively changed.

## The app-managed loop

This was the first blocker. The desktop app, daemon, preview, and playtest IPC
were started from the OhMyGame `dev` checkout with the data directory
`%APPDATA%\ohmygame\data`.

**The official Godot plugin Web build is broken in this workspace.** The
app's Godot `web-build` preview built `.ohmygame/build/web/index.pck`, but the
running game logged:

```text
ERROR: Corrupted header in binary project.binary (not ECFG).
ERROR: Couldn't load project data at path "/". Is the .pck file missing?
```

The game canvas stayed at the 300x150 fallback. The plugin build is not used
for gameplay evidence. This is a product/plugin compatibility finding, not a
Castellan behavior.

**The consumer-owned static preview works.** Atlas now declares a general
OhMyGame Web preview:

- `ohmygame.json` type `general`;
- `package.json` with `dev: node scripts/serve-web.mjs`;
- `scripts/serve-web.mjs` serving the already-built `dist/web` on `HOST`/`PORT`.

OhMyGame starts the server, owns the playtest session, and `game_use` opened:

```text
http://127.0.0.1:56063/?__ohmygame_client=...&__ohmygame_view=playtest&ohmygamePlaytest=1#scenario=castellan
```

The playtest query parameters and the scenario hash coexist. The app-managed
`engine_observations` snapshot reported `sourceRevision=961d2b4...` and
`sourceDirty=false`. The new PR #26 field therefore names the source the
preview started from.

## Scenario-directed entry

Atlas owns the scenario contract. A Web hash
`#scenario=castellan` (or `#scenario=warden`, optional
`job=vanguard|acolyte|ranger|...`) skips the title, places the party at the
encounter, disables route triggers, starts the pack, applies the job without
persisting it, labels the HUD `DEVELOPMENT SCENARIO - ... (not natural play)`,
and records `dev_scenario_started`. Native entry uses
`--dev-scenario=<id>`; the environment-variable fallback was removed so tests
cannot accidentally start a scenario.

OhMyGame needed no new targeting capability: `game_use open` already accepts
a path, query, or hash within the Web target. A new regression test
(`test/playtest-tools.test.ts`) proves a hash-only path keeps
`__ohmygame_view` and `__ohmygame_client`; `docs/runtime.md` now states that a
General project with a Web preview receives the Web adapter even when its
workspace is a Godot project.

The scenario does not persist the Job (`equip(..., false)`) and the encounter
director skips progression when the scene carries the `dev_scenario` meta, so
killing the boss does not mint first-clear rewards. The hash remains public;
a release build should gate or remove it.

## What the gameplay investigation observed

**App-managed captures.** The `game_use` captures show the development
banner, `STABILITY 320/320 - LOCKED` at the Castellan, the Acolyte's
`Eira - Cleanse: Fracture removed`, and a real `r` input producing
`Shield Bash - out of range`. The runtime log shows
`DEV_SCENARIO=castellan JOB=job.vanguard`.

**Findings from the capture itself:**

- The scenario originally placed the player just outside Shield Bash's 2.2 m
  range; a real input produced the correct failure text, but the first
  response was not available. The bootstrap now places the player and
  companions inside the melee space.
- The `LOCKED` suffix persisted after the first cast released because the
  Stability bar only refreshed on a Stability change. It now refreshes every
  frame; the label clears when the guard unlocks.
- The first cast itself was **not reliably captured** through `game_use`. The
  Web game load varied from about 5 to 30 seconds, so fixed waits missed the
  3.8 s cast window. The app logs `DEV_SCENARIO` but exposes no
  scenario-ready event; this is the next investigation capability (a
  scenario-ready signal or a project-owned paused opening).

**Guard economy probe.** The deterministic probe (high-DPS upper bound:
direct slot execution, melee teleport, 500 player HP, default party) compared
guard factors 0.20, 0.35 and 0.50:

| Guard | Interrupt TTK | Guarded / vulnerable | Outside-break TTK | Guarded / vulnerable | Completed | Cancelled | Breaks |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0.20 | 5.85 s | 131 / 519 | 9.85 s | 296 / 354 | 1 | 0 | 1 |
| 0.35 | 5.50 s | 229 / 421 | 9.00 s | 519 / 131 | 1 | 0 | 1 |
| 0.50 | 5.05 s | 328 / 322 | 7.45 s | 650 / 0 | 1 | 0 | 0 |

At 0.20 the outside-break fight is the longest and vulnerable damage is the
largest share. At 0.50, in this high-DPS profile, the boss dies during the
guarded phase with zero vulnerable damage and no break; this is a race, not a
general claim. The probe does **not** exercise the later-cast 2 s cancel:
every break mode has `completed=1`, `cancelled=0`. The 2 s cancel is a
contract test. A lower-DPS control is still needed.

**Canonical journey at `9f92c7d`** (gameplay code unchanged through
`961d2b4`) passed 3/3 Sagas with zero defeats. Causeway telemetry
`telemetry_run_2401.jsonl`:

| Event | Tick | Note |
| --- | ---: | --- |
| Warden command mark | 906 | target `Player`, 2 empowered Reavers |
| Castellan Fracture applied / cleansed | 1162 / 1174 | 0.20 s cleanse |
| Rupture started | 1390 | `cast_index=1`, `grace=1.0` |
| Rupture completed | 1498 | bot did not interrupt |
| Stability broken outside the cast | 1740 | 4.03 s after completion |
| Boss encounter completed | 1878 | 2.30 s after the break |

The first cast resolved; the party earned the **2 s recovery window** after
the guard released, not the 4 s interrupt. The interrupt branch and the later
2 s cancel are contract tests. The final journey now records the Warden mark.

## Atlas refinements

- The first Rupture is interrupt-only and Stability-locked; the bar shows
  `LOCKED` until the first cast ends.
- A completed first cast gives a **2 s** recovery window from the outside
  break; the 4 s window stays tied to the interrupt. The previous 4 s
  outside-cast break made the interrupt optional.
- The guard bar refreshes its lock state every frame; the scenario starts in
  melee range.
- The development scenario uses non-persistent job selection and skips
  encounter progression.
- The static Web preview and project marker make the app-managed session
  reproducible without the broken plugin build.
- The guard probe is labelled `break_outside_cast`, exits non-zero on
  missing/invalid evidence, and asserts one cast and 650 total boss damage.
- The canonical Package 6 receipt remains canonical; the child behavior is
  marked as stacked PR #95/#96.

## Independent review

The earlier design/UX and engineering reviews (Episode 15) had already
returned revise. This mission's engineering review reproduced the focused
tests and probe and raised three blockers: the dev scenario wrote the live
profile/active Job and could mint progression; the probe's "break" was an
outside-cast break, not the later-cast cancel; and the pre-cast lock silently
discarded Stability. The revisions above address the first two and surface
the lock. The review also required an OhMyGame hash-only test and the runtime
docs correction; both are merged.

The fresh Sensemaking beneficiary retrieved the reviewed pack, applied the
revision-bound/feedback/assistance/opportunity lessons, rejected the old
"Rupture skipped" observation as no longer current, and changed the next step
from a general readability pass to an exact-HEAD, app-managed, transfer-first
comparison. It found the stale `dist/web` build and the missing matched
context; its findings drove the static-preview route, the duration fix and
the in-range scenario start.

Remaining review blockers: the app-managed first cast is not yet captured;
the plugin Web build is broken; the scenario hash is public; the 0.50 result
lacks a low-DPS control; the 2 s cancel and 60% cover remain contract-only.
The candidate is still a draft.

## Sensemaking and transfer

The reviewed pack (`27149afb`) was retrieved by a fresh context without the
expected conclusion. It applied:

- runtime evidence is revision-bound (the app now records
  `sourceRevision=961d2b4`, `sourceDirty=false`);
- tests do not establish experiential fulfillment (the app capture, not the
  tests, exposed the out-of-range start and stale lock);
- assistance preserves the decision (the first cast is player-owned);
- a defining mechanic needs opportunity (the scenario entry makes the exam
  reachable; the fixed 3.8 s window still needs a readiness signal);
- feedback separates execution from consequence (the real `r` input produced
  `out of range`).

It adapted the defining-mechanic lesson to a **controlled lab** context and
rejected the old "Rupture skipped" observation. It did not demonstrate that
the release build's first journey teaches the lesson; that remains a
natural-route question.

Cross-genre transfer was not claimed. The same distinction between a
controlled chapter entry and a natural narrative route could apply to Ren'Py,
but no preserved narrative candidate was modified and no cross-domain
cognitive improvement is asserted. A genuine cross-genre application needs a
separate responsibility.

## Limitations

- No human playthrough, motion study, or 1280x720 field qualification.
- The app-managed first cast and interrupt were not captured; the Web load
  timing remains the blocker.
- The official Godot plugin Web build is broken (corrupted
  `project.binary`/PCK); the static preview is a consumer workaround.
- The scenario hash is public and could be used as a cheat entry; progression
  is suppressed, but the entry should be gated in a release.
- The guard probe is a high-DPS, direct-slot upper bound; the 0.50 no-break
  result is profile-specific, and the 2 s later-cast cancel is not in the
  probe.
- The 2 s cancel, 60% cover and later Fracture persistence are contract-only.
- The final Web build was served through the static preview; the plugin build
  path was not qualified.
- Only the default Vanguard party and a Ranger scenario smoke were exercised;
  other Jobs and compositions were not.
- The full `verify.ps1` was not cleanly completed; the inherited ObjectDB
  warning remains.

## Next warranted responsibility

Add a scenario-ready signal or a project-owned paused opening so the
app-managed `game_use` session can reliably capture the first Rupture, answer
it with Shield Bash, and observe the 4 s window; then capture a later 2 s
cancel and 60% cover. Separately, decide whether the official Godot plugin's
Web build should be repaired or whether consumer static previews are the
supported development path. A human/motion pass on the Stability bar,
first-cast pressure and Fracture/cleanse line remains the qualification step.

## Artifacts and revisions

- Atlas PR #96, `feat/dev-scenario-entry`, head `3cf32e2`; code `4fdab48`;
  base PR #95 `4ffa931`; #94 `6a150e4`; #93 `2e8d6e8`.
- Atlas preview files: `ohmygame.json`, `package.json`,
  `scripts/serve-web.mjs`; scenario `game/scripts/dev/dev_scenario_bootstrap.gd`.
- Atlas evidence docs: `docs/implementation/castellan-branded-opening.md`.
- OhMyGame: PR #28 pilot reconciliation; PR #29 hash test/runtime docs;
  `dev` `40c1aa0f`.
- Semantic pack: `27149afb`; fresh beneficiary retrieval recorded in the
  Episode 16 query receipt.
- Preserved #355/#363/#364 unchanged.
