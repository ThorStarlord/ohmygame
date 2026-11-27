# Experience-driven game development v1

**Date:** 2026-11-27
**Status:** The game candidate is in draft PR #355 and is not merged. The OhMyGame product repair is merged into `dev` via PR #17 at `735380d6d016f8778d43442dec18088f7728eedc`.
**OhMyGame:** `ThorStarlord/ohmygame`, `dev` `735380d6d016f8778d43442dec18088f7728eedc`.
**Game:** `ThorStarlord/Superhero-Netorare-Parody`, current `main` `508c94fccdab69ed6912a41808abdae5dcd62ab7`; candidate branch `experience/choice-presentation-v1`.

## Selected responsibility

The repository has no standard in-story `menu:` branches. Its actual consequential player decision is the custom `route_choice` screen called from `label start`: the fresh player begins the False-MC Case View, while the True-MC retrospective appears only after completion. The selected responsibility was therefore the presentation of that real choice, not an invented dialogue menu.

Intended experience:

> A fresh player should understand that they are beginning Part 1 with Marcus Cross, see one clear primary action, and understand that another perspective exists without being told its structure or spoilers. The screen should feel like entering the game's city, not entering a system dialog.

Explicit commitments recovered from the repository:

- Fresh full-game profiles start with False-MC only; True-MC is a retrospective, not a first-run alternative (`10_Human_Docs/09_Player_Route_Access_And_Reconstruction_Contract.md`).
- Fresh profiles may state only that an additional perspective unlocks after completion; no selectable True-MC card or detailed retrospective structure.
- The route controls must be explicit and high-salience, use non-spoiler POV/information descriptors, and stay within the shared dark/neutral/amber visual language (`10_Human_Docs/04_Production_And_Release/49_UI_Interaction_Contract.md`).
- The first read must earn belief in Marcus's viewpoint; the later retrospective changes interpretation without making earlier events false.

## Before observations

The actual built app opened the route screen only after a scale problem was exposed:

- The first live `game_use` open took about **79.9 seconds**, but the extension-host call timeout was **60 seconds**. The app agent reported `Plugin call timed out after 60000 ms`; the next extension-host call exited. A retry later succeeded.
- The live state at the route screen was `status: "unknown"`, `screen: "quick_menu"`, `screens: ["quick_menu"]`, `canAdvance: false`, `canChoose: false`. The custom `route_choice` screen was not named, and there were no available actions.
- The old native checkpoint (`before-route-choice.png`, 65,526 bytes) showed a flat near-black page, a single 690×330 card, the amber `BEGIN FALSE MC ROUTE` label **below** the card's visible background, a separate internal lock note, and a `BACK TO TITLE` control far below.
- The old fresh copy led with `FALSE MC` at 50px and a subheading using "evidence-bound False-MC perspective"; the action was smaller than the card description. The action label sat outside the button surface, so the visual click target was ambiguous even though the scenario could click the text.
- The lock note said the route "reaches its reveal and completion boundary." That is internal design language and is more disclosing than the contract's allowed "unlocks after completion."

## Opportunities considered

1. **Enlarge the existing card only.** It would fix the overflow but preserve the flat, system-dialog feeling and the abstract framing.
2. **Show a locked True-MC card or teaser.** Rejected: the spoiler contract forbids advertising retrospective structure to a fresh profile.
3. **Use a Meridian scene as the chooser background.** Rejected: it would preview story content and risk implying a scene the player has not reached.
4. **Carry the existing title skyline into the chooser and rebuild the single-card composition.** Selected.

## Implemented improvement

In `game/scripts/ui/player_navigation.rpy`:

- Reused the existing `images/title_screen.png` under a dark scrim, so the chooser belongs to the same visual world as the title without previewing a story scene.
- Replaced the top-aligned, fixed-size layout with a centered column. The fresh state is now a deliberate single-entry composition instead of a half-empty two-card layout.
- Made `CASE VIEW` the card title and `FALSE MC` a metadata register. The description now says, "Begin with Marcus Cross and follow the evidence as he encounters it."
- Moved the amber start action into a full-width action band **inside** the card, preserving the amber edge treatment. The same structure is used by the True-MC retrospective card when it is unlocked.
- Replaced the internal lock wording with "Another perspective unlocks after you complete Part 1's first route." This stays within the allowed completion hint.
- Kept `BACK TO TITLE` visible and moved it to a clear top-left control.
- Updated the unlocked heading to `REVISIT PART 1` while keeping both route cards explicit.
- Did not change route IDs, `Return()` actions, unlock logic, story text, or art files.

Added `game/tests/route_choice_test.rpy`, a reusable engine-native scenario that:

- asserts a fresh non-developer profile has no True-MC action;
- clicks `START`, captures the fresh chooser, returns to title;
- clicks `BEGIN FALSE MC ROUTE`, verifies the location label and the first Meridian line, and confirms the chooser is gone;
- seeds `persistent.route_completed["false_mc"]` only in the disposable session, returns to the main menu, and captures the unlocked two-card state;
- ends with `exit`. It creates no canonical screenshot baselines.

The only static-test update was the lock-note assertion in `tests/test_ui_completion_slice.py`.

## After observations

The final engine scenario run `c335c4af-e35c-4151-9d6d-ddc37c1eb936` passed with three retained 1738×977 checkpoints:

- `fresh-route-choice` — 1,301,621 bytes, SHA-256 `bfbe68782e9c538b087cf4e8e68122ad93cd4739f89bb88ae7ccce030a74c832`
- `foundation-opening` — 1,065,484 bytes, SHA-256 `74e2070af006aee9d79bb46cf11c2929a493e9a0bf2cabe8a384c38b502cf64d` (byte-identical before and after)
- `unlocked-route-choice` — 1,202,003 bytes, SHA-256 `3c0b366ad9414fc4ee886cb6d2693c1e939410d2a0a320e581779e2945968b78`

Corresponding checkpoint comparison reported `comparable: true`. The actual app live capture after the change (`route-choice-live-after.jpg`, 84,808 bytes, SHA-256 `10AA5292AC3DD8864C8C4C106EF3202EAC3907B4C8EF09EC7ACAB8CD30F9C4BC`) shows the same composition at 1568×881.

## Evaluation

### Technical

- The native scenario passed both chooser states and the handoff into Marcus's first Meridian line; the direct SDK probe clicked both visible action bands and verified Escape back to title.
- The first Meridian frame is byte-identical before and after, so the change did not alter the story handoff.
- Ren'Py compile passed; `git diff --check` passed.
- Static pytest reported 39 passes and four failures. The four failures are in unchanged review/prologue checks and were reproduced against the original source; they are not caused by this patch. Ren'Py lint is not clean on the unchanged project (missing sprite and undefined-speaker diagnostics in later chapters); this patch adds no parsed lint diagnostic.

### Perceptual

- The fresh screen now has a clear reading order: title → Case View card → description → action → completion hint. The action is inside the card and visibly primary.
- The title skyline provides continuity and avoids the former flat-black modal. The lower city remains visible below the card.
- The unlocked state preserves two explicit cards and fits them side by side without overflow.
- The old 1.09:1 card-surface contrast and 1.18:1 hover contrast remain intentionally restrained; the amber edge and action band provide the structural marker. This is a deliberate noir treatment, not a high-contrast redesign.

### Creative

The screen now introduces Marcus and the evidence-bound Case View before using route taxonomy. It preserves the first-read framing and the conservative completion hint. The choice still points to the same route and does not add narrative branches. The intended experience is better supported by the composition and copy; this is an evaluated interpretation, not player reception or human artistic approval.

### Independent review

A separate reviewer, given only the before/after frames, the diff, the reusable scenario and the governing contracts, returned **accept — no material revision**. It found that the fresh screen answers the four player questions, the hierarchy and action affordance are materially better, the unlocked two-card state fits, and the spoiler/route/visual contracts are preserved. It called the amber tick sufficient but noted that the amber action text and inset band carry the real affordance.

Residual concerns:

- `true_mc_route_unlocked()` includes the developer bypass, so a fresh developer/QA profile may see `REVISIT PART 1` without prior play. This is developer-only and not release-facing; it was accepted as a QA convenience.
- Hover and keyboard-focus states were not captured. The unlocked True card is rendered but not clicked by the reusable scenario; it is verified by code and the separate direct SDK probe, not by a click in that scenario.
- The checkpoints are 1738×977 rather than the 1920×1080 GUI reference, though all comparisons use the same scaled resolution.
- Two unrelated UI-contract tests and one prologue test fail in unchanged code on current `main`; the touched static test passes.

## Consequential OhMyGame limitations and repair

The real game exposed two product limitations:

1. **Large-project live open exceeded the ordinary 60-second plugin call timeout.** The measured direct open was 79.9 s; the app agent's first open failed with `Plugin call timed out after 60000 ms`.
2. **Custom active screens were not reported.** The live state named only `quick_menu` even though the actual screen was `route_choice`.

The OhMyGame repair:

- Gives a plugin type's `gameUse` `open` a five-minute timeout, and raises the Ren'Py adapter's start wait to the same bound. Other operations keep the ordinary timeout.
- Enumerates active screens and returns them in `screens`; `screen` names the primary non-overlay screen. Custom screens are inspectable but remain non-actionable through `choose` in this version.
- Adds a focused test that asserts `open` gets 300,000 ms while inspect and captureFrame keep their existing policy.
- Documents the custom-screen action boundary and the large-project open cost.

Reused in the motivating workflow:

- The current built app opened the real 256 MB game in **41.1 seconds** on the first attempt, within the five-minute allowance.
- The agent received `screen: "route_choice"` and `screens: ["route_choice", "status_case_nav_overlay", "quick_menu"]`, captured the frame, and closed the session.
- A separate current-app live session on `the_question` observed a `transitioning` state, attempted an advance, received `ValueError: dialogue is not awaiting an advance`, inspected again, saw normal dialogue, advanced successfully, and closed. The session survived the refusal.

## Verification

| Check | Result |
|---|---|
| Game route-choice scenario (fresh + unlocked + first line) | Passed; 3 checkpoints; `comparable: true` |
| Game direct SDK visible-action probe | Both routes clicked; Escape returned to title |
| Game compile and diff check | Passed |
| Game pytest | 39 passed, 4 pre-existing failures |
| OhMyGame focused timeout/adapter tests | 3 passed |
| OhMyGame transition/refusal app session | Passed; refusal recovered; close verified |
| OhMyGame real-game live open | 41.1 s; `screen=route_choice`; capture; close |
| OhMyGame typecheck / lint | Passed |
| OhMyGame host build | Passed |
| OhMyGame focused product suite after app shutdown | 84 passed, 2 skipped |
| OhMyGame product PR | #17 merged at `735380d6d016f8778d43442dec18088f7728eedc` |
| Game candidate PR | #355 draft, checks passed, not merged |

## Limits

- No human player or human artistic approval; the evaluation is the agent's evidence-grounded interpretation.
- The game change is a candidate draft PR, not canonical `main`.
- Keyboard focus traversal, hover states, localization fit, text scaling, and first-time-player comprehension remain unverified.
- The live `game_use` runtime can inspect a custom route screen but cannot choose its buttons; that limitation is now visible rather than silently misleading. Scripted scenarios remain the reproducible instrument for this chooser.
- The game project's lint baseline is not clean, and four static tests fail in unchanged code on the current `main`; no comprehensive remediation is included.
- The large open still copies the project and takes tens of seconds; the repair is a timeout and visibility fix, not an incremental copy architecture.

## Evidence

- `H:\GithubRepositories\pilot-data\evidence\experience-development\before-route-choice.png`
- `H:\GithubRepositories\pilot-data\evidence\experience-development\final\fresh-route-choice.png`
- `H:\GithubRepositories\pilot-data\evidence\experience-development\final\unlocked-route-choice.png`
- `H:\GithubRepositories\pilot-data\evidence\experience-development\final\foundation-opening.png`
- `H:\GithubRepositories\pilot-data\evidence\experience-development\app\route-choice-live-after.jpg`
- `H:\GithubRepositories\pilot-data\evidence\experience-development\app\route-live.json`
- `H:\GithubRepositories\pilot-data\evidence\experience-development\app\transition-refusal.json`
- `C:\Users\Admin\AppData\Local\Temp\route-choice-evidence-20261127\before\` and `\after\`
- Game draft PR #355; OhMyGame product PR #17, merged at `735380d6d016f8778d43442dec18088f7728eedc`.
