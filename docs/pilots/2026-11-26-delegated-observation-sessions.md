# Delegated observation sessions v1

**Date:** 2026-11-26
**Status:** Implemented and integrated locally. The complete one-time capture path has a connected application-level harness, and the delegated grant lifecycle was exercised with controlled fixtures and real captured PNGs. No authentic person approval was available in this autonomous run.
**OhMyGame:** `ThorStarlord/ohmygame`, branch `feat/delegated-observation-sessions`, based on `dev` `67c1277a36e7aea6a7173b1d9195e759d7a693b6`.

## Delivered

- **Claimant-bound settlement.** A desktop window that claims a capture request receives a one-time settlement token. Image and error answers must carry it; after another window has claimed a request, a different window that only knows the request ID cannot settle it.
- **Connected one-time capture harness.** One test drives the actual agent tool, one-time capture service, approval decision, managed-session revalidation, capture event, claim token, atomic retention, returned image and exact `captureId` retrieval. Approval is simulated in the test, not claimed as person consent.
- **Bounded observation grants.** An in-app agent can request one observation session for one project, conversation, running native session and root process. The person sees the agent, project, session, purpose, operation, three-attempt limit and absolute end time before choosing **Authorize observation** or **Deny**.
- **Atomic budget accounting.** One attempt is admitted before any capture starts; failures stay consumed; only one capture is in flight per grant. Concurrent admissions cannot exceed the approved budget.
- **Lifecycle boundaries.** New admissions end at expiry, attempt exhaustion, explicit agent end, person revocation, managed-session termination/replacement, conversation archive/delete, project close or daemon restart. An attempt already admitted may finish. It never transfers to a replacement game process.
- **Agent workflow:** `engine_observation_start`, `engine_observation_status`, `engine_observation_capture`, `engine_observation_end`. The existing `engine_capture_request` remains the one-time path, and `engine_capture` remains read-only.
- **Developer surface.** Problems & engine status shows active observation sessions with purpose, session, remaining attempts, expiry and a revoke action. Captures produced under a grant retain `grantId` provenance alongside the request ID, plugin, session, process and image metadata.
- **External MCP remains read-only.** It can read captures and see active grants through `engine_observations`, but cannot initiate one-time or delegated capture.

## Verification

- `test/observation-grants.test.ts` — 7 passed: create, limits, admission, wrong conversation/session/process, exhaustion, expiry, revocation, invalidation, no transfer.
- `test/observation-session-service.test.ts` — 10 passed: approval details, denial, revalidation, budget, expiry, replacement, cross-conversation isolation, one in-flight, revocation and failed-attempt accounting.
- `test/native-capture-requests.test.ts` — 6 passed: claim tokens, wrong-token rejection, cancellation, project/session invalidation and atomic late-answer rejection.
- `test/native-capture-integration.test.ts` — 3 passed: agent tool → approval → revalidation → request → claim → retention → exact retrieval; denial and replaced-session refusal.
- `test/approval-card.test.tsx` — 16 passed, including the bounded observation card and its limits.
- `test/engine-observations-grants.test.tsx` — 2 passed: remaining authority, revoke affordance and empty state.
- `test/native-window-captures.test.ts` — 5 passed; `test/engine-check-history.test.ts` — 6 passed.
- Combined focused grant/capture suite: 55 passed.
- `test/app.test.ts` — 92 passed.
- External MCP, Ren'Py plugin and Godot plugin suites — 62 passed.
- `typecheck`, `lint`, `build:host` and `build:renderer` pass.

## Controlled grant exercise

A controlled integration fixture used the real Ren'Py and Atlas PNGs and a simulated Allow response. It ran:

1. One approval with a three-attempt, ten-minute grant.
2. Three captures, each with a distinct capture ID and the grant ID; the real images were retained (1,457,504 and 150,559 bytes).
3. Remaining budget reached zero and status became `exhausted`.
4. A fourth capture was refused without another request.
5. The grant was ended, a new grant started, and a changed session PID was refused before admission.
6. The new grant was revoked; another capture was refused.
7. A different conversation could not see or capture under the grant.

The fixture produced three capture requests and three retained captures. It is not authentic person consent. Evidence: `H:\GithubRepositories\pilot-data\evidence\delegated-observation-sessions.json.log` and `delegated-observation-sessions-meta.json`.

## Authorization and limits

- The initial grant limits are exactly three admitted attempts and ten minutes. The agent cannot extend or expand them; a new person approval is required.
- Grants are daemon-memory only. No permanent preference or cross-session authorization exists.
- Active grant summaries are project-wide in Problems & engine status and `engine_observations` so the person can revoke them; capture and end operations remain scoped to the requesting conversation.
- Closing the project window cancels pending capture requests and makes a capture attempt fail, but does not itself revoke an active grant. Reopening the same project window within its limits can use the remaining authority; project deletion or daemon restart clears it.
- Attempts are consumed at admission. A failed, cancelled or unavailable window still consumes its attempt. Expiry stops new admissions; a capture admitted before expiry may complete and be retained.
- Revocation immediately prevents new admissions and cancels an outstanding request where possible. A screenshot already obtained by the operating system cannot be undone.
- The claim token protects against another window settling a request by knowing its ID. It does not protect against a compromised trusted renderer that can read the claimant's token.
- No authentic person-approved live grant was exercised. The actual desktop grant status/revoke surface was built and statically tested, but not driven through a real approval.
- External MCP capture initiation remains unavailable.
- Native viewport capture for Godot remains outside the official pinned plugin; the shared Godot diagnostic path from PR #13 is unchanged.
- No native input automation is added.
