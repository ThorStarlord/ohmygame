# Autonomous multi-feature development v1: the Warden-Castellan tactical progression

**Date:** 2026-11-27
**Status:** Atlas candidate `feat/castellan-tactical-progression`, draft PR #95
stacked on the Chain Warden draft PR #94 and cast-visibility draft PR #93.
Not merged into Atlas `main`, not human-playtested. OhMyGame changes reviewed
and merged into `dev` where stated.

**OhMyGame:** `ThorStarlord/ohmygame`, `dev` at
`cb23541756a83a89768d770b2e9464707b8c90bb` (after PR #25 and PR #26).
**Atlas Midgard:** canonical `main`
`5aab42d03b16cb8467822f195a45daedb33c42cc`; cast-visibility PR #93 at
`2e8d6e8`; Chain Warden PR #94 at `6a150e4`; the Castellan candidate PR #95
at `9e4e463`.
**Preserved:** Superhero-Netorare-Parody #355 `e84b6122`, #363 `23b7f084`,
#364 `270150dc`; unchanged.

## Delegated intention

Develop the Ruined Causeway into a coherent tactical progression in which the
Chain Warden teaches recognition, response choice, coordinated pressure and
recovery, and the Riftbound Castellan applies and extends that understanding
through interruption, positioning, Stability, vulnerability, Fracture/cleanse,
and party responsibilities, while preserving "hardcore depth without hardcore
stress."

## What now exists

The Warden is the command encounter. It opens with Command Roar, musters two
Reavers in view, marks the lowest-health-ratio ally on completion, forces the
pack onto the mark, rewards an interrupt with a 3 s / 1.5x window and a 2 s
pause, and gives later commands a 60% companion cover. The full journey
records the completed command, the mark, and two empowered Reavers.

The Castellan is the application exam. It now opens with **Fracture Brand ->
Heavy Line -> Rupture** (Rupture at about 3.0 s) instead of scheduling Rupture
after the fast kill. The first Rupture is the player's: the companion cannot
cover it, and Stability damage is locked during the cast so passive party
pressure cannot cancel the exam. Later Ruptures show the Warden's 60% notch
and allow the Stability answer. While Stability is intact and the boss is not
vulnerable, health damage is multiplied by 0.2; the vulnerability windows are
the damage phases. The player has three answers:

| Answer | What it spends | Result |
| --- | --- | --- |
| Interrupt | Interrupt cooldown, position, range | `RUPTURE BROKEN`; 4.0 s / 1.5x; 2 s pause |
| Break Stability during the cast | Party pressure and uptime | `STABILITY BROKEN`; cast cancelled; 2.0 s / 1.5x |
| Accept the Rupture | Position and recovery | 3 m area strike after 0.65 s; move out or Guard |

A Castellan-only steel `STABILITY` bar makes the alternate visible. The
interrupt resolves before Stability damage in the same hit, so a combined hit
keeps the 4 s window. Fracture is the party-responsibility beat: the Acolyte
cleanses it and the HUD says so. The player HUD also explains failed actions:
`out of range`, `not enough stamina/Guard`, `recharging`, `no target in
reach`, `no cast to interrupt`, `nothing to cleanse`.

The result is a progression in which the Warden's "recognize the command and
answer it" becomes the Castellan's "choose which answer to spend, and read
what the party did." The Castellan is not a renamed Warden: it keeps Heavy
Line, Distance Barrage, Fracture and the Stability break, and its defining
cast is now reached before the kill.

## Design exploration and alternatives

The prior evidence was reproduced: the Castellan died in about 5.4 s, the
first Rupture was scheduled around 6.3 s, the companion had no grace, and the
Stability break at about 4.4 s accelerated the skip. The candidates:

| Option | Assessment |
| --- | --- |
| A. Reorder Fracture -> Rupture, 60% grace, Stability alternate | Directionally right. Literal A lets the companion take the first cast and leaves Stability as a passive damage window. Refined into A'. |
| A'. The Branded Opening (selected) | First cast player-owned; later 60% cover; interrupt 4 s vs Stability 2 s; no HP change; visible guard bar. |
| B. Keep the cycle, add HP/phase gate | Guarantees Rupture but buys time without a new decision; HP sponge or artificial immunity. Rejected. |
| C. Stability-gated Rupture | Strongest second responsibility, but 320 Stability cannot break in 1.8 s with the default party; lowering it makes ordinary DPS trivialise the gate; the companion can erase the second step. Rejected. |
| D. Two simultaneous responsibilities (cleanse + interrupt) | The Acolyte auto-cleanses and the Ranger auto-interrupts; the player becomes a spectator. Rejected. |

The selected design preserves 650 HP / 320 Stability. The ordinary route
reaches Rupture; no health inflation or invulnerability was used.

## Implementation

- `game/scripts/runtime/castellan_boss.gd`: opening order, loop, first-cast
  ownership, interrupt-before-Stability resolution, 2 s Stability cancel, 4 s
  interrupt window, `cast_cancelled`, Stability accessors.
- `game/scripts/visual/stability_telegraph.gd`: Castellan-only guard bar,
  hidden while vulnerable so it does not collide with the result text.
- `game/scripts/visual/actor_visual.gd`: creates the bar and shows
  `STABILITY BROKEN`.
- `game/scripts/debug_hud.gd`, `game/scripts/player_controller.gd`: player
  failure feedback, no-consequence interrupt notice, severe-status line,
  companion cover line.
- `game/scripts/runtime/companion_controller.gd`: `assistance_performed` and
  `can_cover_interrupts()`.
- `game/scripts/runtime/combatant.gd`: read-only status accessors.
- Tests: `smoke_causeway_castellan_encounter.gd`, `smoke_ability_feedback.gd`,
  the extended journey, and the verifier lists.

## Evidence

### Native focused tests

All pass with the pinned Godot 4.7.2 console executable:

- `smoke_causeway_castellan_encounter.gd`: opening order, first-cast grace,
  4 s interrupt, 2 s Stability cancel, combined hit, 60% cover gate, Stability
  bar.
- `smoke_ability_feedback.gd`: failure, status, assistance and cast-detection
  helpers.
- `smoke_causeway_warden_encounter.gd` and
  `smoke_causeway_cast_telegraph.gd`: the Warden behavior and cast/vulnerability
  presentation remain green.
- `smoke_combat_runtime.gd`: status accessors and combat runtime.

### Input-driven full journey

At code `d7a6a06` (guard/first-cast-lock revision) with
`ATLAS_QUALIFICATION_CANDIDATE` set to that SHA, the full journey passed with
3/3 Sagas, `finished=true`, and zero defeats. Causeway telemetry
`telemetry_run_2661.jsonl` records:

| Event | Tick | Payload |
| --- | ---: | --- |
| Warden Command Roar completed | 906 | the command completed; the journey run did not record a mark |
| Castellan Fracture applied | 1162 | `status.fracture` on the player |
| Fracture cleansed | 1174 | `reason=cleanse` (0.2 s later) |
| Castellan Rupture started | 1390 | `cast_index=1`, `grace=1.0` |
| Rupture completed | 1498 | the bot did not interrupt; Stability was locked during the cast |
| Stability broken outside the cast | 1526 | `cast_active=false` |
| Boss encounter completed | 1686 | the 4 s window was truncated by death at 2.67 s |

The Warden mark rule is independently re-verified at this head by
`smoke_causeway_warden_encounter.gd` (`REAL_SCENE_MUSTER_OK mark=Player
empowered_reavers=2`); the final journey run had no valid mark at tick 906
and is not used to claim it. The Castellan's first cast is now interrupt-only,
so the bot's non-interrupt resolved it; the focused contract drives the
player-controller Shield Bash interrupt (4 s), the later-cast Stability cancel
(2 s), the first-cast Stability lock, the guard multiplier, the broken bar and
the automatic refill. The 2 s/4 s choice is established at the contract level,
not as a human decision.

### Rendered evidence

- Native boss probe: `boss_cast_start.png` shows the `STABILITY 320/320` label
  with `RUPTURE / INTERRUPT`; `boss_vulnerable.png` shows `RUPTURE BROKEN` and
  `VULNERABLE 3.9s` without the guard label overlapping.
- Web export from `640bfdc8` (pre-guard): `index.html` `30A4B895...`,
  `index.js` `33C94CB3...`, `index.pck` `24D71E0C...`, `index.wasm`
  `FC74679E...`. Final export from `d7a6a06`: `index.html` `0385C6C4...`,
  `index.js` `33C94CB3...`, `index.pck` `71DC2D09...`, `index.wasm`
  `FC74679E...`. The final export was hashed but not replayed.
  A Chromium/CDP session at 1280x720 on `640bfdc8` observed:
  - `Shield Bash — no target in reach` at the Causeway hub (the prior
    unexplained-failure case);
  - `Shield Bash — recharging 3.5s` during pressure;
  - `Eira — Cleanse: Fracture removed`;
  - `MARKED 76%` on the player during the Warden command;
  - `STABILITY 236/320` over the Castellan with the Heavy Line telegraph;
  - the Castellan defeated and the Causeway recorded as 1/3 Sagas.

This is Web-fidelity evidence, not native Godot and not OhMyGame's
app-managed `game_use`. The Web build predates the guard-cue visibility fix
in `228a204`. The full Rupture cast/cancel was not captured in the Web run
because the boss died before the next cast; the native probe and tests carry
that state.

### Evidence classes

| Class | What it establishes |
| --- | --- |
| Focused tests | The authored contracts and edge cases in a deterministic scene. |
| Input-driven journey | The route reaches the first cast; the bot does not interrupt; the party later breaks Stability for the 4 s window. |
| Native rendered probe | The cues render at the selected camera and resolution. |
| Browser-fidelity run | The same HUD and cues survive the Web export; input and observation are real but not native. |
| Agent evaluation | Design/UX/engineering critique, not human qualification. |

No human playthrough, motion study, or human readability measurement was
performed.

## OhMyGame capability work

**Preview source identity (merged).** `preview.sourceRevision` now records
the workspace Git HEAD at preview start and `preview.sourceDirty` records
whether tracked/untracked files differed. `engine_observations` reports both.
The implementation is `readWorkspaceGitIdentity` in
`src/daemon/workspace-git.ts`, the optional contract fields, and the preview
start path. PR #26 merged at `cb235417`. The focused `workspace-git` suite
passed 23/24; the remaining symlink fixture fails with the inherited Windows
`EPERM`, unrelated to the change. The doc states the limit: the field names
the source the build started from, not the served artifact bytes.

**Manual identity for this run.** Because the app-managed preview was not
running, the Web build identity was recorded manually (source commit plus
four artifact hashes) before the browser run. The new field would let a
future app-managed preview report the same source revision without relying on
memory.

**Not built.** No native Godot `gameUse`, managed native session, viewport
capture, or full parity. The binding limitation in this mission was starting
the desktop app and reaching the boss through a managed runtime, not a missing
native input primitive. The official 1.0.3 plugin still declares no native
`gameUse`.

## Sensemaking

### Preservation

PR #25 merged a source-grounded methodology pack at `.sensemaking/knowledge/
development-methodology.json` (`27149afb`). It contains 13 claims (7 lessons,
6 observations) and 13 relations, including a cross-pack reference to
`lesson:godot-evidence-layers`. An independent review found unsupported
observation wording, a missing cross-pack link, and a misused `depends_on`;
the pack was revised twice before merge. It remains candidate knowledge:
`authority_verified` and `semantic_truth_established` are false.

The index at `27149afb` contains 17 claims / 16 relations (the 4 Godot claims
plus the 13 new claims). A `knowledge-query search` for `feedback`,
`assistance`, `revision`, `opportunity` returned 7 hits with the expected
lessons and explicit `applicability_to_current_question: NOT_ESTABLISHED`.

### Retrieval and application

A fresh agent context received the evaluation responsibility and the index,
without the expected lessons. It ran nine bounded queries (orientation,
snapshot, two searches, three explain calls, and a term lookup) and retrieved
the new methodology lessons plus the existing Godot evidence claims. It judged:

- **Applied:** runtime evidence is revision-bound (the Web build and telemetry
  did not name the source), tests do not establish experiential fulfillment
  (the focused tests call boss methods directly), and feature quality needs
  integrated evaluation (the journey used only one answer).
- **Applied/adapted:** the Episode 14 Warden-to-Castellan transfer was found
  unsupported, not merely untested; the Web preview had already served a
  pre-revision build; the first Shield Bash failure was unexplained. The
  beneficiary moved the next step from a general readability pass to an
  exact-HEAD, app-managed, transfer-first decision test.
- **Rejected/not applicable:** the Episode 14 "Rupture skipped" observation
  no longer applies (the new journey reaches it), and the first-cast companion
  cover is rejected (grace 1.0). The 60% later cover is adapted as intentional.

The beneficiary also found the 2 s window drawn against a 4 s denominator, the
journey assertion able to pass on a Bridge Hexer's Fracture, and the
`cover_first` test actually probing the second cast. Those findings drove the
vulnerability-duration fix, the scoped journey assertion, the first-cast
Stability lock, the guard, and the player-controller interrupt test. This is
an observable influence on the evaluation plan and the revision, not a claim
of causal cognitive improvement.

The primary agent's own application:

- **Applied:** revision-bound evidence. The Web build was built from a named
  commit, hashed, and reported separately from the native and test evidence.
- **Applied:** assistance preserves the decision. The first Rupture is
  player-owned; later casts use the 60% cover.
- **Applied:** a defining mechanic needs opportunity. The opening was
  reordered rather than adding HP or invulnerability.
- **Applied:** feedback separates an attempted action from its consequence.
  The HUD now names range, resource, cooldown, target, and no-cast outcomes.
- **Adapted:** the "full five-stage taxonomy" remains a design proposal; the
  pilot did not measure player comprehension.
- **Rejected:** a Stability-gated Rupture (C) and a two-simultaneous-
  responsibility design (D), because the default party and companion
  automation made the second step either impossible or spectator-like.

## Independent review

**Design/UX verdict: revise.** The reviewer found that the exam was real in
code but not owned in the only ordinary route: the party's passive Stability
pressure cancelled the first Rupture, the player's Shield Bash was on cooldown
at cast start, the boss died 0.8 s into the reward window, the Stability bar
collided with the cast cue and hid its own broken state, Fracture was a 0.2 s
automation, and the single feedback lane conflated missing target/out of
range, flooded on basic attacks, and could overwrite assists.

**Engineering verdict: revise.** The reviewer confirmed the core state machine
but found the 2 s Stability window drawn against a 4 s denominator, the
full-journey assertion able to pass on a Bridge Hexer's Fracture, the canonical
Package 6 receipt asserting unmerged child behavior, and gaps around the
broken-bar state, automatic restore, the real player-controller interrupt, the
companion cover promise, dead-boss casts, and HUD width/late companion binding.

**Revisions in response.** The first Rupture is now interrupt-only and
Stability-locked; a 0.2 guard multiplier makes the vulnerability windows the
damage phases; the opening beats are 1.75 s so the player's interrupt is off
cooldown; the cast cue says `INTERRUPT ONLY`; the Stability bar moved below the
cast bar and keeps the broken state while hiding a still-full guard during the
interrupt window; the vulnerability duration is stored per window; the
player-controller Shield Bash path is tested; the journey assertion is scoped
to `pack.boss` and the first cast's `grace`; the canonical Package 6 receipt is
restored and the child behavior is marked stacked; basic attacks are excluded
from failure text, missing-target text includes the range, the no-cast notice
is target-aware, feedback has a priority lane, and the cover wording names the
companion and the cast.

**Remaining review blockers.** The measured 4 s window is still truncated by
death at 2.67 s; the 2 s cancel, the later 60% cover and the second Fracture
are contract-only. The Stability label is still small at 1280x720 and the
`STABILITY 320/320` text can crowd the boss's head. The dead-boss cast guard,
the HUD width at x=930, late companion binding, and a full human/motion pass
remain open. The candidate is therefore still a draft, not merge-ready.

## Limitations

- No human playthrough, motion study, or 1280x720 field qualification. The
  cues are rendered and tested; how a player reads them is not measured.
- On the default bot route the first Rupture completed (the bot did not
  interrupt), then the party broke Stability outside the cast for the 4 s
  window. The player-controller interrupt and the 2 s cancel are contract
  tests, not the ordinary route.
- The first Rupture has no companion cover. A player who is out of range and
  does not understand the `INTERRUPT ONLY` cue may take the area strike.
- The measured 4 s window was truncated by death at 2.67 s. The 2 s cancel,
  the later 60% cover and the later Fracture persistence are not reached in
  the fast first journey.
- The guard's 0.2 health-damage multiplier is a first tuning value; it makes
  the vulnerability windows the damage phases but is not human-tuned.
- Fracture is cleansed in about 0.2 s on the default route; the status line
  may not dwell. The cleanse line is the primary cue, and the Fracture beat is
  companion support, not a player decision.
- The Stability label is small at 1280x720 and sits below the cast bar; it is
  legible in the native frame but not human-qualified.
- The Castellan is global; the Rift Echo/Interlocked Trial inherit the opening
  and the bar. The additional-endgame-enemy mapping is metadata-only in this
  checkout and was not re-run.
- The Web run was Chromium/CDP, not OhMyGame's app-managed `game_use`; the
  desktop app and its playtest IPC were not running. The source/build identity
  was manual. The new preview field was not exercised in that run.
- The full `verify.ps1` was not cleanly completed after the revisions; the
  inherited PowerShell/ObjectDB warning remains. The focused tests and the
  full journey pass.
- Only the default Vanguard/companion party was played; other Jobs and
  companion configurations were not.
- The installed Sensemaking Skill revision remains unresolved; the pinned
  source supplied the contracts.

## Next warranted responsibility

Run the committed candidate through the app-managed Web `game_use` path with
the new preview source identity, capturing the first Rupture answered by a
player interrupt, the Stability cancel, and a later 60% cover frame. Then run
a human/motion readability pass on the Stability bar, the first-cast pressure,
and the Fracture/cleanse line. A separate balance decision can ask whether the
second Rupture and Distance Barrage should appear in the fastest route; that
is pacing, not a reason to raise health preemptively.

## Artifacts and revisions

- Atlas candidate: PR #95, `feat/castellan-tactical-progression`, head
  `4ffa931`; code `d7a6a06`; base PR #94 `6a150e4`; PR #93 `2e8d6e8`.
- Atlas docs: `docs/implementation/castellan-branded-opening.md`,
  `docs/implementation/package-6-boss-synthesis.md`,
  `docs/implementation/causeway-cast-visibility.md`,
  `docs/implementation/chain-warden-command-roar.md`,
  `docs/vertical-slice/encounters-and-map.md`.
- OhMyGame semantic pack: PR #25, `27149afb`.
- OhMyGame preview source identity: PR #26, `9000fa9f`, merged `cb235417`.
- OhMyGame pilot and Episode 15 receipts: this document and
  `.sensemaking/receipts/2026-11-27-autonomous-multi-feature-v1.*.yaml`.
