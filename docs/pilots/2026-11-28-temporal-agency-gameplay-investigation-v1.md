# Temporal agency for gameplay investigation v1: controlled live scenarios

**Date:** 2026-11-28
**Status:** Episode 17. Atlas candidate `feat/dev-scenario-entry` (draft PR
#96) stacked on PR #95/#94/#93; not merged into canonical `main`, not
human-qualified. OhMyGame changes merged into `dev`.

**OhMyGame:** `ThorStarlord/ohmygame`, `dev` at
`a0096d3bab8fc7d854b54449fd69511f3817de4b` (after PR #28, #29, #30 and #31).
**Atlas Midgard:** canonical `main`
`5aab42d03b16cb8467822f195a45daedb33c42cc`; PR #93 `2e8d6e8`; PR #94
`6a150e4`; PR #95 `4ffa931`; PR #96 `ca8acf5` (control code `da217e8`).
**Preserved:** Superhero-Netorare-Parody #355 `e84b6122`, #363 `23b7f084`,
#364 `270150dc`; unchanged.

## Inherited limitation

Episode 16 established the app-managed `game_use` path, consumer scenario
entry, preview source identity, real input and rendered feedback. Its
decisive failure was temporal: the Atlas Web game loaded in about 5 to 30
seconds, while the Castellan's first tactical decision occurred 3.8 seconds
after encounter initialization. Fixed waits missed the 1.8-second cast; the
scenario exposed no readiness signal or paused opening. The first cast and its
4-second interrupt were not app-captured.

The selected direction was:

**observable readiness + controlled opening + repeatable reset.**

The design remained consumer-owned. OhMyGame provides the managed runtime,
logging, input and source identity; Atlas defines what its encounter, party and
timing mean.

## Controlled scenario lifecycle

`game/scripts/dev/dev_scenario_bootstrap.gd` now provides:

- **Ready hold.** After the real Causeway scene and boss pack initialize, the
  HUD banner and `ENCOUNTER READY` overlay are drawn, the boss's decision timer
  is held before its first opening beat, and the tree pauses. The runtime
  prints `DEV_SCENARIO_READY ... phase=ready_paused`. The scene is at full HP
  with no Fracture.
- **Explicit commencement.** `Enter`/`Space` releases the hold and prints
  `DEV_SCENARIO_COMMENCED`; the opening Fracture/Heavy Line/Rupture begins.
- **Investigative cast pause.** The first Rupture pauses on the real cast and
  prints `DEV_SCENARIO_CAST_PAUSED cast=rupture index=1 hint=INTERRUPT ONLY
  grace=1.00`. `Enter` resumes; the real `R` input performs Shield Bash.
- **Later-cast option.** `pause=all` also pauses later Ruptures and prints the
  `INTERRUPT / STABILITY` hint and the 60% cover grace. `pause=none` leaves
  casts running for deterministic probes.
- **Reset.** `F10` reloads the scene and returns to the ready hold with the
  same disposable investigation profile.
- **Support party.** `party=support` removes Sigrid and leaves the player with
  Eira, a controlled composition for the later-cast investigation.

The encounter rules themselves are unchanged: cast duration, cooldowns,
Stability lock, 2-second/4-second rewards and party behavior are the shipped
rules. The hold and pause are development timing; an interrupt made from a
held cast is a controlled investigation, not a natural-speed playthrough.

## Isolation and production gate

- The scenario switches `ProgressionService` to a uniquely named `dev-*`
  profile under `user://dev-scenarios/profiles` before the Causeway loads.
  Encounter completion, Job changes and item/history operations therefore
  write only to the disposable profile, never the live one.
- `equip(..., false)` selects the Job without persisting the player's active
  Job; the encounter director still skips progression as a second boundary.
- The scenario autoload is inert unless `OS.is_debug_build()` or the
  `atlas_dev_scenarios` custom feature is present. The consumer preview export
  (`scripts/export-web-dev.mjs`) opts in; an ordinary release export without
  the feature leaves `#scenario=...` inert.
- `smoke_dev_scenarios.gd` asserts the disposable profile and ready hold;
  `smoke_dev_scenario_lifecycle.gd` asserts the ready hold, cast pause, real
  interrupt and reset; `smoke_dev_scenario_later.gd` asserts the index-2 pause
  and 0.60 grace in the support party.

## Managed investigation evidence

All runs used the actual OhMyGame desktop, daemon, preview, playtest IPC and
`game_use`, at 1280x720. The app's `setVisible(true)` watch control was
required: a hidden Electron playtest window runs at a heavily reduced frame
rate even with `backgroundThrottling` off. The new `game_use open visible:true`
option (OhMyGame PR #31) makes that control part of the managed call.

| Run | Source | Dirty | Build `index.pck` |
| --- | --- | --- | --- |
| A/B | `a6ddcb8` | false | `DD3CC443D261F2DD167499DF234F3E66AA6103861AB6939DD3EC21B9318D62C5` |
| C | `dd91a5c` | false | `692FE6AB37738DAAE6CA984EB46A3AA77EEC46E293A90CFD627FC6377B4875BC` |

`index.js` was
`33C94CB3175F3333B82E2A3BE5E8E86F77986F0AA2042B1631F6367A4E5BB6BA` and
`index.wasm`
`FC74679E3B97F76878947FCD4FBE1268CBFA6188182A2E33BBC3F5DC9BFA57D0` in both.

### A: successful opening interrupt

`DEV_SCENARIO_READY scenario=castellan job=job.vanguard party=full
phase=ready_paused` -> `DEV_SCENARIO_COMMENCED` -> ticks at 1.0/2.1/3.1 s ->
`DEV_SCENARIO_CAST_PAUSED cast=rupture index=1 hint=INTERRUPT ONLY grace=1.00`
-> `DEV_SCENARIO_RESUMED` -> real `r` -> `DEV_CAST_INTERRUPTED cast=RUPTURE
index=1 vulnerability=4.0` -> `DEV_BOSS_DEFEATED`.

The capture shows `RUPTURE BROKEN`, `VULNERABLE 3.6s`, the party's damage and
the 4-second reward. The player's HP was 76 at the cast (the opening Heavy
Line); the interrupt was real input after the held observation.

### B: accepted Rupture and 2-second recovery

A fresh run under the same source/build held the same opening. The player
resumed, stepped out of the strike, returned to melee and did not interrupt.
The logs show `DEV_CAST_COMPLETED cast=RUPTURE index=1
vulnerability=4.0`, then `DEV_STABILITY_BROKEN cast_active=false index=1` and
`DEV_VULNERABILITY duration=2.0 remaining=2.0`. The boss survived the shorter
window and restored Stability. A and B distinguish the player-owned 4-second
interrupt from the 2-second accepted-and-broken recovery.

### C: later Rupture and 60% cover

The default party killed the Castellan before its second Rupture. The Acolyte
support party lost the player at about 9 seconds. The Vanguard + Eira support
party reached the later cast:

`DEV_SCENARIO_CAST_PAUSED cast=rupture index=2 hint=INTERRUPT / STABILITY
grace=0.60`.

The capture shows the later cast, `STABILITY 62/320`, the `LATER RUPTURE`
pause notice and the 60% cover text. The cast completed; the companion did not
actually cover it. The later 2-second Stability cancel remains contract-only
in the tested configurations: the fight ends or the party pressure is
insufficient before the bar breaks during the 1.8-second cast. This is a
pacing/party-pressure boundary, not evidence that the mechanic is absent.

## Guard and vulnerability economy

The earlier high-DPS probe reported 0.20/0.35/0.50. A lower-DPS control
(`tests/castellan_guard_low_dps.gd`, attack once per second, no Shield Bash,
party kept alive) now separates the guard from the race:

| Guard | Outside-break TTK | Guarded / vulnerable | Casts | Breaks |
| ---: | ---: | ---: | ---: | ---: |
| 0.20 | 15.7 s | 301 / 349 | 1 | 1 |
| 0.50 | 11.0 s | 584 / 66 | 1 | 1 |

At 0.50 the low-DPS fight reaches the break; the high-DPS zero-break was a
race. But the vulnerable share collapses to 10% at 0.50 versus 54% at 0.20.
The ×0.2 value is retained: it keeps the vulnerability window as the damage
phase without erasing the guarded phase. The lower-DPS control is a mechanical
probe, not natural play.

## Godot plugin Web export diagnosis

The plugin Web build's PCK contains a zero-byte `project.binary`; the consumer
export contains the 20,321-byte `ECFG` binary. The plugin preset excludes
`.ohmygame/*` while exporting into `.ohmygame/build/web/index.html`; Godot
writes a temporary `project.binary` into that output folder, and the exclude
filter removes it from the pack. A controlled export to the same output with
`exclude_filter=""` contains a 20,269-byte `ECFG` `project.binary`; the narrow
filter `.ohmygame/local/*, .ohmygame/settings.json, .ohmygame/.gitignore` does
too. The repair candidate is
`docs/implementation/godot-plugin-web-export-fix.patch`. It is not applied
because the plugin is a preinstalled product package; the consumer static
preview remains the supported development path until the plugin is repaired.
No external publication was made.

## OhMyGame retained capability

PR #31 adds `visible: true` to `game_use open`. The desktop driver shows the
playtest window, and the existing Preview watch toggle remains for sessions
already open. This is the smallest retained capability that matches the
observed limitation: a hidden Electron window throttles animation, so a timed
scenario can disappear before the agent can act. Unit tests (`playtest-tools`)
and typecheck pass; the external MCP call set the watch state from false to
true. The `sourceRevision`/`sourceDirty` fields were exercised clean at both
A/B and C source revisions.

## Sensemaking and methodological adaptation

A fresh beneficiary received the timing problem without the expected
conclusion. It retrieved the reviewed OhMyGame pack at `27149afb` and ran nine
queries. It applied `lesson:runtime-evidence-is-revision-bound`,
`lesson:tests-do-not-establish-experiential-fulfillment`,
`lesson:isolated-mechanic-correctness-is-not-feature-quality` and
`lesson:godot-evidence-layers`; it treated
`lesson:defining-mechanic-needs-opportunity` as a contrast, not a governing
claim, because its opportunity is the player's expected-route opportunity.

It rejected the candidate text "a defining gameplay interaction needs
sufficient opportunity to be investigated" as a restatement and proposed a
separate investigator-side lesson:

> An interaction that resolves faster than the investigator's end-to-end
> observe-reason-act cycle, including build, load, capture and tool latency,
> cannot be reliably investigated from an uncontrolled real-time run; the
> development environment needs an explicit, reversible temporal control that
> reaches and holds the interaction without changing its rules. Where the hold
> is placed determines what it preserves: a hold before the action can
> preserve execution timing while extending decision time; a hold during the
> action preserves neither. The controlled observation establishes the
> interaction's presentation, rules and consequences, not natural-speed
> answerability, readability, player experience or natural-route frequency.

The beneficiary's strongest counterexample is the fidelity paradox: the
Castellan's first Rupture is defining because it is time-bounded; holding it
proves the reward wiring, not that a player can answer it. The lesson is
therefore preserved with explicit conditions and claim ceiling, not as a
universal rule and not as an amendment to the player-side lesson. A detached
`knowledge-proposal-check` returned `SEMANTIC_KNOWLEDGE_PROPOSAL_VALID`
(3 claims, 3 relations) before the new pack was committed as
`.sensemaking/knowledge/temporal-gameplay-investigation.json`; it is
**declared** knowledge, not retrieved truth or a promoted replacement for the
reviewed pack.

## Independent review

**Experiential critique (needs refinement).** The managed A/B pair is a clean
controlled contrast: a real `r` interrupt opens 4 s and kills; accepting the
cast and breaking Stability outside opens 2 s and the boss survives. The
critic found the economy coherent as a **first-cast exam plus window-dominant
economy**, not yet as a three-answer fight. The 2 s is a fallback, not a
competing decision, because the 4 s interrupt dominates when it is available.
C shows the 60% notch but no cover event; the default party kills the boss
before the second Rupture, and the support party that reaches it does not
produce a cover. The critic also flagged the `LOCKED` bar before the exam, the
duplicate `STABILITY BROKEN` labels, and the thin unlabeled 60% notch. The doc
and pilot now state the cover and later cancel as contract-only. The critic
recommended phase-gating or reordering the second Rupture and giving the 2 s
fallback a tempo payoff; those are preserved as the next systemic direction,
not rushed into this temporal-agency episode. The ×0.2 guard is retained; the
critic would test ×0.35 at low DPS before changing it.

Independent engineering and Godot-integration reviews were also commissioned.
Their findings and the resulting revisions are recorded in the final episode
reconciliation. No review grants authority to merge Atlas #93–#96 into
canonical `main`.

## Limitations

- No human playthrough, motion study, or player-comprehension measurement.
- The first cast's interrupt was performed under a held cast; it establishes
  the reward wiring and the real input path, not natural-speed answerability.
- The later 2-second Stability cancel is contract-only; the 60% cover was
  observed but did not resolve in the managed run.
- Default-party pacing kills the Castellan before its second cast; the support
  party that reaches it is a controlled composition, not the default route.
- The low-DPS guard probe keeps the party alive and attacks on a fixed cadence;
  it is a mechanical control, not natural play.
- The hidden-window throttling is mitigated by `visible:true`; the app still
  requires a visible window for real-time investigation, which is a product
  behavior to watch in future sessions.
- The official Godot plugin's Web build is still broken; the consumer static
  preview is the workaround.
- The scenario's progression is intentionally suppressed. It therefore cannot
  yet investigate first-clear rewards, Hearth services, equipment or history
  through the managed runtime.

## Next responsibility

Autonomous Gameplay Investigation is sufficiently established for
encounter-level investigation. The strongest bounded systemic direction is the
relationship among **Job identity, party composition, companion cover and
encounter pacing** across the Warden–Castellan progression, because the managed
evidence shows reachability and cover are composition-dependent. Before a
large systemic project, the development scenario needs a disposable profile
that **can** record isolated progression (rewards, Hearth, history) and be
reset, so persistent systems can be investigated without touching the live
save. That is the smallest capability response; the encounter-level temporal
loop no longer needs a standalone qualification milestone.

## Artifacts and revisions

- Atlas PR #96, `feat/dev-scenario-entry`, head `ca8acf5`; control code
  `da217e8`; base PR #95 `4ffa931`; #94 `6a150e4`; #93 `2e8d6e8`.
- Atlas captures: `docs/assets/temporal-investigation/`.
- Atlas plugin repair candidate:
  `docs/implementation/godot-plugin-web-export-fix.patch`.
- OhMyGame PR #31, `feat/game-use-visible`, merged into `dev`
  `a0096d3b`; `game_use open visible:true`, test and runtime docs.
- Episode 17 session and query receipts under `.sensemaking/receipts/`.
- Preserved #355/#363/#364 unchanged.
