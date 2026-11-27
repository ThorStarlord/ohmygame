# Experience-driven game development v2

**Date:** 2026-11-27
**Status:** The `arc3_ch10` presentation candidate is draft PR #364 and is not merged. The Arc 3 Iris declaration fix is a separate draft PR #363. The targeted-entry capability is merged into OhMyGame `dev` via PR #19 at `8ca9492da357e9c54421becce5bf38e96a3b50f6`.

**OhMyGame:** `ThorStarlord/ohmygame`, start `ca190e7cdf64df35f5a74fae453fbaaa883dc92d`, end `8ca9492da357e9c54421becce5bf38e96a3b50f6`.
**Game:** `ThorStarlord/Superhero-Netorare-Parody`, investigation baseline `a9a875e68cda9313b77ac60c065c535801495e73`; canonical `main` later advanced to `113e21ae25d83bb69f7c174c36df3b228c45f8ac` without touching the candidate files.
**Game candidates:** #364 `experience/narrative-investigation-v2` at `270150dc2aaf33c69c974f09ca515eae89cea209`; #363 `fix/arc3-iris-expression-ids` at `23b7f084f903d377f2dbd7c4b0269dbf450d1cbf`; #355 remains the separate draft presentation candidate at `e84b6122e57c34b5f9f2d7b62010e26d0e6e459a`.

## Selected responsibility

The selected chapter is `arc3_ch10`, **The Socratic Sledgehammer**, at reader position 165: the bridge confrontation between Marcus Cross and HW. It is the thematic payoff of the Impossible Targets sequence, and it is one of the few non-Iris, route-reachable scenes with four bespoke state images mapped to argument turns.

Intended experience, grounded in `Canon/manuscript/chapters/165_Arc3_Ch10_The_Socratic_Sledgehammer.md` and `trackers/TRUE_MC_POSITION_165_PRESENTATION_CONTRACT.md`:

> The player should see two facts at once: HW is prepared, controlled and genuinely perceptive; Marcus is wounded but still cognitively and morally active enough to distinguish the truth of the indictment from the right to control. The state changes should mark argument turns, not decorative mood beats. Neither figure should become a triumphant owner of the scene.

Recovered commitments:

- Explicit: no Goddess reveal, no aura truth oracle, no visual declaration of ownership; four states at structural turns; both characters visible together.
- Convention: the game uses NVL retrospective narration and ADV spoken dialogue; location labels and the dark reading plate are shared UI.
- Inferred: the scene needs enough facial legibility to read Marcus's wound and HW's self-audit crack, but the bridge and the dialogue carry most of the meaning.
- Selected judgment: repair the integrated assets and display tags rather than redesign the NVL layout or rewrite dialogue.

Iris `arc3_iris_ch4` was the strongest alternative because it has an approved `quiet_vulnerability` expression at its emotional climax. It was not selected: the chapter has deeper manuscript, outfit-continuity, background and chronology concerns, and its canonical expression IDs did not even resolve at runtime. That missing declaration is a real, separate defect, preserved as PR #363 rather than folded into the ch10 candidate.

### Repository governance

The game repository's `AGENTS.md` currently places adult D1-D8 manuscript reconstruction ahead of native QA and presentation queues, and defers new native QA or Ren'Py adaptation unless a new owner request or stable narrative boundary warrants it. This mission is that explicit owner request. The ch10 and Iris candidates remain isolated drafts and do not displace the story-first priority.

## Entry and context

The chapter has no required story variables or route flags. Entering it directly still omits context that a normal player would have:

- the distributed-evidence setup from `arc3_ch9`;
- the route's `arc3.ogg` music;
- the surrounding retrospective call stack and prior dramatic information.

The chapter's confrontation is self-contained enough to evaluate its presentation, but direct entry is not equivalent to normal progression. This record distinguishes the requested label, the executed entry, the observed state, and the omitted context.

Live sessions used the new `game_use open` `start` field:

- before repair: `plugin-24238b1c-1e27-464a-bdcd-d9839c0ad64d`;
- after repair: `plugin-0198c10d-2805-4385-96df-54ec7bec5099`;
- packaged 0.3.1 verification: `plugin-7ee7df9f-0f09-4571-887b-69aaf034f1b3`;
- Iris ch4: the separate expression session in conversation `01a21cb2-a1cc-77d7-9a30-c3bac02ee6dc`.

The app conversation records are in `evidence/experience-v2/app-conversations/`.

## Before observations

The first live ch10 session exposed two independent presentation failures:

1. **Shared display tag.** `show sprite marcus m1` and `show sprite hw h1` both used the `sprite` tag, so the second replaced the first. The live agent saw only one card at a time. When Marcus spoke, HW was absent; when the state changed, the other card disappeared.
2. **Inverted alpha.** The four 512x680 PNGs had opaque card backdrops and transparent character pixels. Faces, hair and torsos revealed the bridge behind them; the cards read as framed panels with hard black bands, not as people in the scene.

A later QA capture at 1.0 s still appeared to show only Marcus; increasing the wait to 2.0 s produced both figures, consistent with the sequential fade and dissolve timing. The capture timing was corrected, not the scene.

After the alpha inversion, a solid black strip remained below the busts (the baked bottom 80 px of the cards; 70 px on `hw_h2`). Thin pure-black vertical slivers also rose from the hair to the image top on three assets, and a later review found semi-transparent black residue still above the hair on all four. These were asset residue, not scene content.

## Opportunities considered

1. **Add distinct tags only.** Fixes coexistence but leaves transparent faces and black card bars. Rejected as incomplete.
2. **Regenerate the four state images.** The assets were already human-approved and had a documented production path. Rejected in favor of repair.
3. **Alpha-only repair, distinct tags, same-tag crossfades, and removal of the baked bands/residue.** Selected. It preserves RGB, dimensions, character placement, narrative text and the existing composition contract.
4. **Redesign the NVL layout or move the whole confrontation to ADV.** The opening is NVL by design; the argument turns already use ADV and read. A global layout change would exceed the scene and needs stronger evidence. Deferred.
5. **Rewrite dialogue or manuscript.** Out of scope; the scene's text and character commitments are preserved.
6. **Add generic state injection to reach the chapter.** Rejected. An optional engine label is the smaller, truthful capability.

## Implemented candidate

In `game/scripts/arc3/ch10.rpy`:

- `show sprite marcus m1 as marcus`, `show sprite hw h1 as hw`, and the matching state changes. The two characters now have independent tags.
- The M2/H2 changes replace the same tag with `with dissolve` instead of hiding first, so the old state does not disappear for a frame before the new one fades in.

In the four `game/images/sprites/part1_position165/*.png` assets:

- `ALPHA_INVERSION_ONLY`: `255 - alpha`, RGB and dimensions unchanged;
- `LETTERBOX_ALPHA_CLEAR`: cleared only the opaque black bottom band rows;
- `TOP_SLIVER_ALPHA_CLEAR`: cleared only connected pure-black sliver pixels above the hair;
- `TOP_RESIDUE_ALPHA_CLEAR`: cleared only rows wholly above the first non-black hair pixels, removing the remaining semi-transparent black residue.

The repair chain and before/after hashes are recorded in `state/expression_production/position165/`:

- `state_asset_alpha_repair_v1.json`
- `state_asset_letterbox_repair_v1.json`
- `state_asset_top_sliver_repair_v1.json`
- `state_asset_top_residue_repair_v1.json`

Final asset hashes:

| State | SHA-256 |
|---|---|
| Marcus M1 | `980278763D4A63550FCC191A39FFCCCD33B69D6E206BF2E3AE5213375628BB9D` |
| Marcus M2 | `2C24EBDE2D2829881F1F57C0F6E4620CFA2897F128B8B887371E9488D8F0EE87` |
| HW H1 | `8D2CBD3217F2ED313A2EF265CD4BD90A1C1E08351AA03FA56E8DFEA8E6B945CF` |
| HW H2 | `ACB73F317FFC8E056F15B70683FAF84780CE751C1C9D2D035512759FB8B170FF` |

`trackers/TRUE_MC_POSITION_165_PRESENTATION_CONTRACT.md` records the repairs and final hashes.

`game/tests/arc3_ch10_presentation_test.rpy` is a retained engine-native scenario. It waits for the full entrance, asserts both tags and the exact state attributes, and captures the opening, the bright M1/H1 pair, Marcus M2, and HW H2 at their argument turns. It creates no canonical baselines.

## After observations

The final scenario run `893313f6-f225-42d3-ab0e-2bdd5a1188c0` passed with four checkpoints and 12 assertions:

- `arc3-ch10/01-opening-both` - both figures present under the NVL plate, no black strip or top residue; this particular capture does not show the first line because of test timing, while the live session did;
- `arc3-ch10/01b-bright-m1h1` - the bright M1/H1 pair in ADV, both faces readable;
- `arc3-ch10/02-marcus-m2` - Marcus M2 while HW H1 remains;
- `arc3-ch10/03-hw-h2` - HW H2 while Marcus M2 remains.

The live agent's after-repair report: "Both Marcus and HW are visible and legible together ... intact faces with no silhouette or bridge scenery showing through them." The M2 and H2 changes were observed at the argument turns while the other figure stayed on stage.

### Technical

- The QA scenario passed all four checkpoints and 12 assertions, including the exact `marcus/m1`, `hw/h1`, `marcus/m2` and `hw/h2` attributes.
- The four assets resolve at 512x680 with transparent surroundings; the display tags no longer replace each other, and the state swaps crossfade instead of hiding first.
- No story text, route logic, save data or branching changed.
- The candidate was authored on game `main` `a9a875e68`; later canonical `main` `113e21ae2` changes editorial manuscripts and status docs, not the candidate's touched files. The draft PR is mergeable at `270150dc`.

### Perceptual

- The bright M1/H1 capture shows Marcus left and HW right on the maintenance span with readable eyes and faces.
- The M2/H2 frames keep both figures on stage; the bridge is no longer visible through their faces, and the black strip and top residue are gone.
- The full-screen NVL plate still leaves the opening figures close to silhouettes. The argument turns are in ADV, where the dialogue panel covers Marcus's mouth/chin and the lower torsos but leaves the faces readable. The opening's dimness remains a real atmospheric limit.
- The busts are still hard card cutouts: the bottom cut and the left/right asset edges clip the torsos and shoulders, and the semi-transparent panel only partly hides the bottom boundary.

### Creative

The repair makes the contract's two simultaneous facts present and lets the state changes land as argument turns rather than card swaps. It does not establish that a player will feel the intended wound, jurisdiction or self-audit; that needs human reception. The dialogue, character commitments and bridge setting are preserved. M1 does not visibly carry the manuscript's torn cape or face dust, and H2 reads more stern/defensive than self-auditing.

### Independent review

A separate senior reviewer checked the contract, hashes, RGB/alpha arithmetic, tag usage, captures, wardrobe and cut edges. Verdict: **accept with a named limitation** - the repair is a real, proportionate fix for a previously unusable scene, but it is not presentation-complete.

The reviewer's strongest additional finding was a **wardrobe discontinuity**: H1 has a crossbody strap, a SENTINEL chest patch and a low ID badge; H2 has none of those and a different badge/pouch. At the H2 turn in bright ADV this reads as a continuity error and distracts from the self-audit beat. The approved assets would need art revision; this candidate does not alter them. The reviewer also confirmed the NVL near-silhouette opening, the hard cutout edges, and the subtle H2 read. No human visual or player pass was performed.

## Consequential OhMyGame limitation and repair

Live playtesting always began at the game's normal opening. Reaching position 165 by replaying the route is expensive and makes repeated visual comparison impractical; jumping to a source location without its context would have been misleading.

The smallest coherent repair was an optional, engine-validated start label for plugin-backed `game_use`:

- a plugin type declares `gameUse.start`;
- `game_use open` accepts `start` only when the type advertises it;
- the Ren'Py adapter checks `renpy.has_label`, starts the isolated session there, reports the requested `start`, and refuses a missing label without falling back;
- a failed open cleans up its copy and leaves no usable session;
- no arbitrary Python, state injection or cross-engine navigation language was added.

The manifest schema, runtime, tool schema, Ren'Py adapter, docs, plugin README, Skill and focused tests were updated. The Ren'Py plugin moved to `0.3.1`.

Verification:

- `bun run test -- test/playtest-tools.test.ts test/plugin-game-runtime.test.ts`: 39 passed.
- `bun run typecheck`, `bun run lint`, `bun run plugin:check plugins/renpy`, `bun run build:host`: passed.
- Live source-plugin sessions opened `arc3_iris_ch4` and `arc3_ch10` and advanced adaptively from returned state.
- A missing label `ohmygame_missing_label_probe` returned `ValueError: start label 'ohmygame_missing_label_probe' does not exist`, did not fall back, and left no session.
- The packaged `0.3.1` was installed, the project moved to it, and `open start: "arc3_ch10"` reported `start`, the ch10 label, the first line, and both characters.

PR #19 was merged into `dev` at `8ca9492da357e9c54421becce5bf38e96a3b50f6`. The capability was then used in the workflow that motivated it, not merely demonstrated in isolation.

## Arc 3 Iris side finding

`arc3_iris_ch1` through `ch4` use canonical ADR-005 IDs such as `sprite iris bust direct_engagement`, but `backgrounds.rpy` only declared legacy aliases (`direct`, `intimate_verification`, `concerned`). The canonical `show` did not resolve. The approved 350x450 assets and the runtime registry already existed.

PR #363 adds the canonical declarations for the bust, portrait and side forms, plus `iris_arc3_expressions_qa`. The scenario passed independently in its own worktree: 5 assertions, the `direct_engagement` -> `quiet_vulnerability` captures, and the three 350x450 size checks. It remains draft and unmerged. The chapter's deeper manuscript, outfit, background and chronology concerns are not addressed by that declaration fix.

## Sensemaking Beneficiary Experience - Episode 12

The OhMyGame repository has no numbered episode ledger. This record uses **Episode 12** as the owner's next series identifier and links it to the prior v1 session rather than claiming an automatic ledger.

**What prior understanding was sought.** The v1 pilot, its session receipt, the game's presentation contract and the previous recommendation to continue with a bounded narrative/presentation responsibility.

**How it was recovered.** By explicit file reads of `docs/pilots/2026-11-27-experience-driven-development.md` and `.sensemaking/receipts/2026-11-27-experience-driven-development.session.yaml`, plus ordinary repository inspection. The `using-sensemaking` Skill was loaded through the harness. No semantic index, grounding pack or automatic cross-session surfacing was available or used.

**Provenance and applicability.** The v1 receipt's next responsibility remained applicable: a bounded narrative/presentation improvement. Its custom-screen-action recommendation was not applicable to this scene, because ch10 uses ordinary dialogue and sprites rather than a custom choice screen. The v1 lesson to keep the game candidate separate and to use engine-rendered evidence was applied. The prior Iris work did not determine the chapter choice; actual repository evidence selected ch10 instead.

**Which consequential decisions it influenced.** The prior record informed the decision to investigate a real chapter through live state-dependent play rather than build more infrastructure, to implement the smallest targeted-entry capability instead of state injection, to distinguish direct entry from normal progression, and to keep the ch10, Iris and #355 candidates separate. It also supported the decision not to redesign the NVL layout without stronger evidence.

**What new knowledge was preserved.** The ch10 failure modes (shared tag, inverted alpha, baked letterbox, top slivers and semi-transparent residue), the repair procedure and final hashes, the same-tag crossfade and exact-attribute QA, the targeted-entry contract and its refusal path, and the Atlas Midgard recommendation below.

**Where Sensemaking was insufficient.** Retrieval was manual. The receipt format is typed but the episode series is not represented in the repository. The current validator reports both earlier OhMyGame receipts as invalid against the evolved schema (missing IDs, enums and typed fields); they remain immutable historical records, so continuity is manual rather than machine-readable. The new Episode 12 receipt validates. No automatic continuity or comparative cognitive improvement was demonstrated. The local Sensemaking checkout is `9ae5338b9f5be80cec3af02b7fed30965b7a7503`, behind `origin/main` by 349 commits and carrying unrelated local modifications; the exact loaded revision is not established beyond the harness copy. These remain Sensemaking-process opportunities, not changes made here.

**What ordinary engineering and creative reasoning accomplished independently.** The visual diagnosis, the decision that alpha inversion was the correct repair, the narrative candidate comparison, the product implementation, and the judgment that the NVL dimness should be reported rather than redesigned were ordinary development reasoning, checked against engine-rendered evidence.

## Remaining limitations

- The game candidates are draft PRs; nothing was merged into the game's canonical `main`. #355 remains a separate draft. The candidate is not presentation-complete.
- No human player, artistic approval or player-value measurement. The evaluation is the agent's and independent reviewer's evidence-grounded interpretation.
- The opening NVL plate leaves both figures close to silhouettes; the ADV panel covers Marcus's mouth/chin and the lower torsos. Motion, transition timing and audio were not evaluated.
- H1 -> H2 is a wardrobe change, not only an expression change; the approved assets would need art revision. The H2 expression is subtler and reads more stern/defensive than self-auditing.
- The busts remain hard card cutouts: the bottom cut and the left/right asset edges clip the torsos and shoulders, and the semi-transparent panel only partly hides the bottom boundary.
- The first NVL line can overlap the location label depending on the existing inset latch timing; the global UI was not changed.
- Direct entry omits ch9 setup, route music and the normal call stack. It is not equivalent to player progression.
- The game `main` advanced after the investigation; the candidate was not rebased, though the later changes do not overlap its files.
- OhMyGame has no remote CI on this fork; the focused checks, host build and live app execution are the local evidence. The full suite was not rerun.
- The Iris declaration fix is real but separate; the chapter's deeper creative concerns remain for its own review.
- No comparative or longitudinal Sensemaking improvement is claimed.

## Evidence

Root: `H:\GithubRepositories\pilot-data\evidence\experience-v2\`

- `ch10-live/` - before-repair live captures and the first ch10 session.
- `ch10-final5/` - final engine-rendered checkpoints, including the bright M1/H1 pair.
- `ch10-final3/` - earlier checkpoints before the top-residue and crossfade refinements.
- `qa/` and `iris-fix/` - Iris expression captures before and after the declaration fix.
- `app-conversations/` - saved ch4, ch10 and packaged-0.3.1 conversation JSON.
- `final/` - earlier Iris scene captures.

Key runs: ch10 QA `893313f6-f225-42d3-ab0e-2bdd5a1188c0` (4 checkpoints, 12 assertions); Iris QA `e9f10308-a758-413d-9181-90933a0360eb`.

## Next warranted responsibility

The next cross-engine exercise should be a bounded **Atlas Midgard** scene-improvement mission, not a parity campaign. Select one real Godot scene with a stateful presentation or interaction beat; enter it through an existing project-defined test/entry point; inspect the live scene state; make one coherent improvement; and compare engine-rendered before/after evidence. The discriminating questions are which OhMyGame practices transfer (targeted entry, active-state inspection, scenario checkpoints, agent-driven evidence) and which Godot-specific primitives are required (scene-tree state, input actions, animation state, viewport capture) rather than Ren'Py dialogue/screen equivalents. Do not build full Godot interactive parity first.

This recommendation is not an authorization to start that separate mission.
