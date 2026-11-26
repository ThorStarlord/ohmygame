import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error Plugin native modules are intentionally plain JavaScript.
import { closeAllInteractiveSessions, interactiveGameUse } from "../plugins/renpy/native/interactive.mjs";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

let folder: string;
let fake: string;
beforeEach(async () => {
  folder = await mkdtemp(path.join(tmpdir(), "ohmygame-renpy-live-test-"));
  await mkdir(path.join(folder, "game"), { recursive: true });
  await writeFile(path.join(folder, "game", "script.rpy"), "label start:\n    return\n");
  fake = path.join(folder, "fake-engine.cjs");
  await writeFile(fake, [
    "const fs = require('node:fs');",
    "const net = require('node:net');",
    "const path = require('node:path');",
    "const root = process.argv[process.argv.length - 1];",
    "const endpoint = process.env.OHMYGAME_LIVE_ENDPOINT;",
    "const token = process.env.OHMYGAME_LIVE_TOKEN;",
    "let started = false;",
    "let step = 0;",
    "let choices = [];",
    "let dialogue = 'Opening line';",
    "function state() {",
    "  return { kind: 'renpy', status: started ? 'awaiting' : 'main_menu', interactionId: 'interaction-' + step,",
    "    ...(started ? { statement: 'say', screen: 'say', dialogue } : {}),",
    "    choices: choices.map((text, index) => ({ id: 'choice-' + index, text, chosen: false })),",
    "    canAdvance: started && choices.length === 0, canChoose: choices.length > 0,",
    "    screens: started ? ['say', 'quick_menu'] : ['main_menu'], viewport: { width: 1280, height: 720 } };",
    "}",
    "const server = net.createServer((socket) => {",
    "  let buffer = '';",
    "  socket.on('data', (chunk) => {",
    "    buffer += chunk.toString('utf8');",
    "    while (true) {",
    "      const index = buffer.indexOf('\\n');",
    "      if (index < 0) break;",
    "      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);",
    "      const request = JSON.parse(line);",
    "      const send = (response) => socket.write(JSON.stringify({ id: request.id, ...response }) + '\\n');",
    "      if (request.token !== token) { send({ ok: false, error: 'invalid token' }); continue; }",
    "      if (request.op === 'inspect') send({ ok: true, value: state() });",
    "      else if (request.op === 'start') { started = true; step = 1; dialogue = 'First line'; send({ ok: false, error: 'JumpOutException: start' }); }",
    "      else if (request.op === 'advance') {",
    "        if (request.interactionId && request.interactionId !== 'interaction-' + step) send({ ok: false, error: 'stale interaction' });",
    "        else { step += 1; dialogue = step >= 3 ? 'A choice approaches' : 'Next line ' + step; if (step === 3) choices = ['Ask now', 'Ask later']; send({ ok: true, value: { queued: true } }); }",
    "      } else if (request.op === 'choose') {",
    "        if (request.interactionId !== 'interaction-' + step) send({ ok: false, error: 'stale interaction' });",
    "        else if (!choices[Number(String(request.choiceId).slice(-1))]) send({ ok: false, error: 'choice unavailable' });",
    "        else { step += 1; dialogue = 'After the choice'; choices = []; send({ ok: true, value: { clicked: true } }); }",
    "      } else if (request.op === 'capture') { fs.writeFileSync(request.path, Buffer.from(" + JSON.stringify(PNG.toString("base64")) + ", 'base64')); send({ ok: true, value: { saved: true } }); }",
    "      else if (request.op === 'close') { send({ ok: true, value: 'closing' }); setTimeout(() => { socket.end(); server.close(); process.exit(0); }, 20); }",
    "      else send({ ok: false, error: 'unsupported' });",
    "    }",
    "  });",
    "});",
    "server.listen(0, '127.0.0.1', () => {",
    "  fs.writeFileSync(endpoint, JSON.stringify({ port: server.address().port }));",
    "});",
  ].join("\n"));
});
afterEach(async () => {
  await closeAllInteractiveSessions();
  await rm(folder, { recursive: true, force: true });
});

function command() {
  return { executable: process.execPath, prefixArgs: [fake], sdkPath: folder };
}

describe("Ren'Py interactive playtest session", () => {
  it("opens isolated gameplay, advances, chooses, captures and closes", async () => {
    const opened = await interactiveGameUse(command(), folder, { operation: "open" }, { label: "start" });
    expect(opened).toMatchObject({
      session: expect.stringMatching(/^renpy-live-/),
      viewport: { width: 1280, height: 720 },
      gameState: { kind: "renpy", status: "awaiting", interactionId: "interaction-1", dialogue: "First line", canAdvance: true },
    });
    const session = opened.session;
    const first = await interactiveGameUse(command(), folder, { operation: "inspect", session });
    expect(first.gameState).toMatchObject({ interactionId: "interaction-1", dialogue: "First line" });
    const advanced = await interactiveGameUse(command(), folder, {
      operation: "act", session,
      actions: [{ type: "advance", interactionId: first.gameState.interactionId }],
    });
    expect(advanced.gameState).toMatchObject({ interactionId: "interaction-2", dialogue: "Next line 2" });
    const choice = await interactiveGameUse(command(), folder, {
      operation: "act", session,
      actions: [{ type: "advance", interactionId: advanced.gameState.interactionId }],
    });
    expect(choice.gameState).toMatchObject({ canChoose: true, choices: [{ id: "choice-0" }, { id: "choice-1" }] });
    const capture = path.join(folder, "capture.png");
    await interactiveGameUse(command(), folder, { operation: "capture", session, output: capture });
    expect(await readFile(capture)).toEqual(PNG);
    const chose = await interactiveGameUse(command(), folder, {
      operation: "act", session,
      actions: [{ type: "choose", choiceId: "choice-0", interactionId: choice.gameState.interactionId }],
    });
    expect(chose.gameState).toMatchObject({ dialogue: "After the choice", canChoose: false });
    await expect(interactiveGameUse(command(), folder, {
      operation: "act", session,
      actions: [{ type: "choose", choiceId: "choice-0", interactionId: choice.gameState.interactionId }],
    })).rejects.toThrow(/stale|unavailable/);
    await interactiveGameUse(command(), folder, { operation: "close", session });
    await expect(interactiveGameUse(command(), folder, { operation: "inspect", session })).rejects.toThrow(/no longer open/);
  });

  it("refuses an unknown session and unsupported actions", async () => {
    await expect(interactiveGameUse(command(), folder, { operation: "inspect", session: "not-a-session" })).rejects.toThrow(/no longer open/);
    const opened = await interactiveGameUse(command(), folder, { operation: "open" });
    await expect(interactiveGameUse(command(), folder, {
      operation: "act", session: opened.session, actions: [{ type: "click", target: { x: 1, y: 1 } }],
    })).rejects.toThrow(/does not support click/);
    await interactiveGameUse(command(), folder, { operation: "close", session: opened.session });
  });
});
