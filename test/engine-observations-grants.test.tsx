import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ObservationGrantList } from "../src/renderer/engine-observations-panel.js";
import type { ObservationGrantSummary } from "../src/shared/engine-observations.js";

const grant: ObservationGrantSummary = {
  id: "grant-1",
  sessionId: "session-1",
  sessionLabel: "Ren'Py",
  plugin: "thorstarlord/renpy",
  purpose: "Check the dialogue layout",
  maxAttempts: 3,
  admitted: 1,
  completed: 1,
  failed: 0,
  remaining: 2,
  inFlight: false,
  createdAt: 1,
  expiresAt: Date.now() + 600_000,
  status: "active",
};

describe("Observation grant list", () => {
  it("shows purpose, session, remaining attempts, expiry and revoke", () => {
    const html = renderToStaticMarkup(createElement(ObservationGrantList, { grants: [grant], onRevoke: () => {} }));
    expect(html).toContain("Observation sessions");
    expect(html).toContain("Check the dialogue layout");
    expect(html).toContain("Ren&#x27;Py");
    expect(html).toContain("2 of 3 attempts left");
    expect(html).toContain("Revoke observation");
  });

  it("explains when there is no active authority", () => {
    const html = renderToStaticMarkup(createElement(ObservationGrantList, { grants: [], onRevoke: () => {} }));
    expect(html).toContain("No active observation session.");
  });
});
