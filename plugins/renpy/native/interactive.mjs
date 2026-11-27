// A disposable, engine-native Ren'Py playtest session.
//
// The SDK runs a copied project with its own savedir. A generated init file
// starts a loopback socket adapter inside the engine. The adapter exposes only
// inspect, start, advance, choose, capture and close; it does not accept Python
// or shell commands. The app's game_use runtime owns the session id, and the
// plugin keeps the child process and copied project until close.
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";

const START_TIMEOUT_MS = 5 * 60_000;
const ACTION_TIMEOUT_MS = 15_000;
const MAX_OUTPUT = 16_000;
const MAX_ACTIONS = 20;
const MAX_CHOICE_ID = 100;
const MAX_INTERACTION_ID = 100;

const sessions = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function copyTree(source, target, skip) {
  const info = await lstat(source).catch(() => undefined);
  if (!info || info.isSymbolicLink() || !info.isDirectory()) return false;
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      await copyTree(from, to, skip);
      continue;
    }
    if (entry.isFile()) await copyFile(from, to);
  }
  return true;
}

async function interactiveProject(project) {
  const root = await mkdtemp(path.join(tmpdir(), "ohmygame-renpy-live-"));
  try {
    const projectRoot = await realpath(project);
    const game = path.join(projectRoot, "game");
    const gameInfo = await lstat(game).catch(() => undefined);
    if (!gameInfo || gameInfo.isSymbolicLink() || !gameInfo.isDirectory())
      throw new Error("The project has no regular game folder to play in isolation");
    await copyTree(game, path.join(root, "game"), new Set(["saves", "cache", ".ohmygame-scenario"]));
    const state = path.join(projectRoot, "state");
    await copyTree(state, path.join(root, "state"), new Set());
    const savedir = path.join(root, "saves");
    const capture = path.join(root, "captures");
    await mkdir(savedir, { recursive: true });
    await mkdir(capture, { recursive: true });
    return { root, game: path.join(root, "game"), savedir, capture, endpoint: path.join(root, "endpoint.json") };
  } catch (error) {
    await rm(root, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

function adapterSource() {
  return [
    "init 999 python:",
    "    import hashlib as _live_hashlib",
    "    import hmac as _live_hmac",
    "    import json as _live_json",
    "    import os as _live_os",
    "    import socket as _live_socket",
    "    import threading as _live_threading",
    "    import traceback as _live_traceback",
    "    from renpy.test import testfocus as _live_testfocus",
    "    from renpy.test import testmouse as _live_testmouse",
    "",
    "    class _LiveAdapter(object):",
    "        def __init__(self):",
    "            self.endpoint = _live_os.environ.get('OHMYGAME_LIVE_ENDPOINT')",
    "            self.capture_root = _live_os.environ.get('OHMYGAME_LIVE_CAPTURE_DIR')",
    "            self.token = _live_os.environ.get('OHMYGAME_LIVE_TOKEN', '')",
    "            self.label = _live_os.environ.get('OHMYGAME_LIVE_LABEL', 'start')",
    "            self.started = False",
    "            self.port = None",
    "            self.error = None",
    "",
    "        def log(self, text):",
    "            if not self.endpoint:",
    "                return",
    "            try:",
    "                with open(self.endpoint + '.log', 'a', encoding='utf-8') as file:",
    "                    file.write(str(text) + '\\n')",
    "            except Exception:",
    "                pass",
    "",
    "        def start_once(self):",
    "            if self.started:",
    "                return",
    "            self.started = True",
    "            self.log('starting adapter')",
    "            renpy.invoke_in_thread(self.serve)",
    "",
    "        def main(self, fn):",
    "            box = {}",
    "            done = _live_threading.Event()",
    "",
    "            def run():",
    "                try:",
    "                    box['value'] = fn()",
    "                except BaseException as error:",
    "                    box['error'] = '%s: %s' % (type(error).__name__, error)",
    "                    if isinstance(error, renpy.game.JumpOutException):",
    "                        raise",
    "                    _live_traceback.print_exc()",
    "                finally:",
    "                    done.set()",
    "",
    "            try:",
    "                renpy.invoke_in_main_thread(run)",
    "                renpy.queue_event('__ohmygame_live_wake__')",
    "            except Exception as error:",
    "                return {'ok': False, 'error': 'schedule: %s: %s' % (type(error).__name__, error)}",
    "            if not done.wait(10):",
    "                return {'ok': False, 'error': 'main thread did not answer'}",
    "            if 'error' in box:",
    "                return {'ok': False, 'error': box['error']}",
    "            return {'ok': True, 'value': box.get('value')}",
    "",
    "        def serve(self):",
    "            try:",
    "                server = _live_socket.socket(_live_socket.AF_INET, _live_socket.SOCK_STREAM)",
    "                server.setsockopt(_live_socket.SOL_SOCKET, _live_socket.SO_REUSEADDR, 1)",
    "                server.bind(('127.0.0.1', 0))",
    "                server.listen(1)",
    "                self.port = server.getsockname()[1]",
    "                temporary = self.endpoint + '.tmp'",
    "                with open(temporary, 'w', encoding='utf-8') as file:",
    "                    _live_json.dump({'port': self.port}, file)",
    "                _live_os.replace(temporary, self.endpoint)",
    "                self.log('listening %d' % self.port)",
    "                connection, _ = server.accept()",
    "                self.log('accepted')",
    "                stream = connection.makefile('rwb')",
    "                while True:",
    "                    line = stream.readline()",
    "                    if not line:",
    "                        break",
    "                    request = _live_json.loads(line.decode('utf-8'))",
    "                    if not _live_hmac.compare_digest(str(request.get('token', '')), self.token):",
    "                        response = {'ok': False, 'error': 'invalid session token'}",
    "                    else:",
    "                        response = self.handle(request)",
    "                    response['id'] = request.get('id')",
    "                    stream.write((_live_json.dumps(response) + '\\n').encode('utf-8'))",
    "                    stream.flush()",
    "                    if request.get('op') == 'close':",
    "                        break",
    "                connection.close()",
    "                server.close()",
    "            except Exception as error:",
    "                self.error = '%s: %s' % (type(error).__name__, error)",
    "                _live_traceback.print_exc()",
    "                try:",
    "                    with open(self.endpoint + '.error', 'w', encoding='utf-8') as file:",
    "                        file.write(self.error)",
    "                except Exception:",
    "                    pass",
    "",
    "        def handle(self, request):",
    "            operation = request.get('op')",
    "            if operation == 'inspect':",
    "                return self.main(self.state)",
    "            if operation == 'start':",
    "                return self.main(lambda: self.start(request.get('label', self.label)))",
    "            if operation == 'advance':",
    "                return self.main(lambda: self.advance(request.get('interactionId')))",
    "            if operation == 'choose':",
    "                return self.main(lambda: self.choose(request.get('choiceId'), request.get('interactionId')))",
    "            if operation == 'capture':",
    "                return self.main(lambda: self.capture(request.get('path')))",
    "            if operation == 'close':",
    "                renpy.invoke_in_main_thread(renpy.quit)",
    "                return {'ok': True, 'value': 'closing'}",
    "            return {'ok': False, 'error': 'unsupported operation'}",
    "",
    "        def state(self):",
    "            choice = renpy.get_screen('choice')",
    "            items = []",
    "            if choice is not None:",
    "                for index, item in enumerate(choice.scope.get('items', [])):",
    "                    items.append({",
    "                        'id': 'choice-%d' % index,",
    "                        'text': str(getattr(item, 'caption', '')),",
    "                        'chosen': bool(getattr(item, 'chosen', False)),",
    "                    })",
    "            say = renpy.last_say()",
    "            who = say.who",
    "            speaker = None",
    "            if who is not None:",
    "                speaker = getattr(who, 'name', None) or str(who)",
    "            what = say.what",
    "            current = renpy.game.context().current",
    "            label = None",
    "            if isinstance(current, str):",
    "                label = current",
    "            elif isinstance(current, (tuple, list)) and current:",
    "                label = str(current[0])",
    "            screens = []",
    "            try:",
    "                active = sorted(",
    "                    ((getattr(screen, 'zorder', 0), name) for (name, _variant), screen in renpy.display.screen.screens.items() if screen is not None),",
    "                    key=lambda item: item[0],",
    "                    reverse=True,",
    "                )",
    "                for _zorder, name in active:",
    "                    if name not in screens and renpy.get_screen(name) is not None:",
    "                        screens.append(name)",
    "            except Exception:",
    "                screens = []",
    "            for name in ('main_menu', 'say', 'choice', 'quick_menu', 'nvl'):",
    "                if name not in screens and renpy.get_screen(name) is not None:",
    "                    screens.append(name)",
    "            overlays = {'quick_menu', 'status_case_nav_overlay', 'notify', 'location_label'}",
    "            primary = next((name for name in screens if name not in overlays), screens[0] if screens else None)",
    "            statement = renpy.get_statement_name()",
    "            main_menu = 'main_menu' in screens",
    "            say_screen = 'say' in screens",
    "            nvl_screen = 'nvl' in screens",
    "            choice_screen = choice is not None",
    "            transitioning = statement in ('with', 'scene', 'show', 'hide', 'pause') or renpy.get_ongoing_transition() is not None",
    "            if main_menu:",
    "                status = 'main_menu'",
    "            elif transitioning:",
    "                status = 'transitioning'",
    "            elif choice_screen or say_screen or nvl_screen:",
    "                status = 'awaiting'",
    "            elif renpy.store.main_menu:",
    "                status = 'main_menu'",
    "            else:",
    "                status = 'unknown'",
    "            digest = _live_hashlib.sha1(",
    "                ('|'.join([statement or '', str(what or ''), label or '', '|'.join(screens), '|'.join(item['text'] for item in items)])).encode('utf-8')",
    "            ).hexdigest()[:20]",
    "            return {",
    "                'kind': 'renpy',",
    "                'status': status,",
    "                'interactionId': digest,",
    "                'statement': statement,",
    "                **({'label': label} if label else {}),",
    "                'screen': primary,",
    "                **({'speaker': str(speaker)} if speaker else {}),",
    "                **({'dialogue': str(what)} if what else {}),",
    "                'choices': items,",
    "                'canAdvance': bool((say_screen or nvl_screen) and not choice_screen and not transitioning),",
    "                'canChoose': bool(choice_screen),",
    "                'screens': screens,",
    "                'viewport': {'width': renpy.config.screen_width, 'height': renpy.config.screen_height},",
    "            }",
    "",
    "        def start(self, label):",
    "            if renpy.get_screen('main_menu') is None:",
    "                return {'alreadyStarted': True}",
    "            renpy.jump_out_of_context(label or 'start')",
    "",
    "        def advance(self, interaction):",
    "            current = self.state()",
    "            if interaction and interaction != current.get('interactionId'):",
    "                raise ValueError('stale interaction; inspect the current state before advancing')",
    "            if not current.get('canAdvance'):",
    "                raise ValueError('dialogue is not awaiting an advance; inspect the current state')",
    "            renpy.queue_event('dismiss')",
    "            return {'queued': True}",
    "",
    "        def choose(self, choice_id, interaction):",
    "            current = self.state()",
    "            if not interaction or interaction != current.get('interactionId'):",
    "                raise ValueError('stale interaction; inspect the current choices before choosing')",
    "            if not isinstance(choice_id, str) or not choice_id:",
    "                raise ValueError('choiceId is required')",
    "            choice = renpy.get_screen('choice')",
    "            if choice is None:",
    "                raise ValueError('no choice screen is available')",
    "            items = choice.scope.get('items', [])",
    "            found = None",
    "            for index, item in enumerate(items):",
    "                if choice_id == 'choice-%d' % index:",
    "                    found = item",
    "                    break",
    "            if found is None:",
    "                raise ValueError('choice is not available in the current state')",
    "            caption = str(getattr(found, 'caption', ''))",
    "            focus = _live_testfocus.find_focus(caption, False)",
    "            if focus is None:",
    "                raise ValueError('choice button is not available to the engine')",
    "            x, y = _live_testfocus.find_position(focus, (None, None))",
    "            _live_testmouse.click_mouse(1, x, y)",
    "            return {'choiceId': choice_id, 'x': x, 'y': y, 'clicked': True}",
    "",
    "        def capture(self, filename):",
    "            if not isinstance(filename, str) or not filename:",
    "                raise ValueError('capture path is required')",
    "            root = _live_os.path.normcase(_live_os.path.realpath(self.capture_root))",
    "            target = _live_os.path.normcase(_live_os.path.realpath(filename))",
    "            if not (target == root or target.startswith(root + _live_os.sep)):",
    "                raise ValueError('capture path escapes the session folder')",
    "            if not renpy.screenshot(filename):",
    "                raise ValueError('the engine could not write the screenshot')",
    "            return {'saved': True}",
    "",
    "    _live_adapter = _LiveAdapter()",
    "",
    "init 1000 python:",
    "    config.periodic_callbacks.append(_live_adapter.start_once)",
    "",
  ].join("\n");
}

function sanitizeState(value) {
  const state = value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
  if (!state) throw new Error("The Ren'Py playtest adapter returned no state");
  const text = (item, limit) => typeof item === "string" ? item.slice(0, limit) : undefined;
  const status = ["main_menu", "awaiting", "transitioning", "finished", "unknown"].includes(state.status) ? state.status : "unknown";
  const choices = Array.isArray(state.choices) ? state.choices.slice(0, 20).filter((item) =>
    item && typeof item === "object" && typeof item.id === "string" && typeof item.text === "string")
    .map((item) => ({ id: item.id.slice(0, MAX_CHOICE_ID), text: item.text.slice(0, 500), chosen: item.chosen === true })) : [];
  const viewport = state.viewport && typeof state.viewport === "object"
    && Number.isInteger(state.viewport.width) && Number.isInteger(state.viewport.height)
    && state.viewport.width > 0 && state.viewport.height > 0
    ? { width: state.viewport.width, height: state.viewport.height } : undefined;
  const screens = Array.isArray(state.screens) ? state.screens.filter((item) => typeof item === "string").slice(0, 20) : [];
  return {
    kind: "renpy",
    status,
    ...(text(state.interactionId, MAX_INTERACTION_ID) ? { interactionId: text(state.interactionId, MAX_INTERACTION_ID) } : {}),
    ...(text(state.label, 200) ? { label: text(state.label, 200) } : {}),
    ...(text(state.statement, 100) ? { statement: text(state.statement, 100) } : {}),
    ...(text(state.screen, 100) ? { screen: text(state.screen, 100) } : {}),
    ...(text(state.speaker, 200) ? { speaker: text(state.speaker, 200) } : {}),
    ...(text(state.dialogue, 8_000) ? { dialogue: text(state.dialogue, 8_000) } : {}),
    choices,
    canAdvance: state.canAdvance === true,
    canChoose: state.canChoose === true,
    screens,
    ...(viewport ? { viewport } : {}),
    ...(Array.isArray(state.errors) ? { errors: state.errors.filter((item) => typeof item === "string").slice(0, 8).map((item) => item.slice(0, 1_000)) } : {}),
  };
}

function connect(session) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port: session.port });
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("The Ren'Py playtest adapter did not accept a connection")); }, 10_000);
    socket.once("connect", () => { clearTimeout(timer); resolve(socket); });
    socket.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
}

function request(session, operation, fields = {}) {
  if (session.closed || !session.socket) return Promise.reject(new Error("The Ren'Py playtest session has closed"));
  return new Promise((resolve, reject) => {
    const id = ++session.requestId;
    const timer = setTimeout(() => {
      session.pending.delete(id);
      reject(new Error(`Ren'Py playtest ${operation} timed out`));
    }, ACTION_TIMEOUT_MS);
    session.pending.set(id, { resolve, reject, timer });
    session.socket.write(JSON.stringify({ id, token: session.token, op: operation, ...fields }) + "\n");
  });
}

async function waitForEndpoint(session) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const endpoint = JSON.parse(await readFile(session.endpoint, "utf8"));
      if (Number.isInteger(endpoint.port) && endpoint.port > 0) {
        session.port = endpoint.port;
        return;
      }
    } catch {
      // Not written yet.
    }
    const error = await readFile(session.endpoint + ".error", "utf8").catch(() => undefined);
    if (error) throw new Error(error);
    if (session.exitCode !== undefined) throw new Error(`Ren'Py exited before its playtest adapter was ready (${session.exitCode}). ${session.output}`);
    await sleep(200);
  }
  throw new Error(`Ren'Py did not start its playtest adapter. ${session.output}`);
}

async function waitForGame(session) {
  const deadline = Date.now() + 12_000;
  let last;
  while (Date.now() < deadline) {
    last = await request(session, "inspect");
    if (last.status !== "main_menu" && (last.dialogue || last.choices.length || last.canAdvance || last.canChoose)) return last;
    await sleep(200);
  }
  return last;
}

async function startSession(command, project, options) {
  const isolated = await interactiveProject(project);
  const token = randomBytes(24).toString("hex");
  const session = {
    id: `renpy-live-${randomUUID()}`,
    token,
    root: isolated.root,
    endpoint: isolated.endpoint,
    capture: isolated.capture,
    output: "",
    outputTruncated: false,
    requestId: 0,
    pending: new Map(),
    socket: undefined,
    child: undefined,
    exitCode: undefined,
    closed: false,
  };
  const append = (chunk) => {
    const text = chunk.toString("utf8");
    if (session.output.length + text.length > MAX_OUTPUT) session.outputTruncated = true;
    session.output = (session.output + text).slice(-MAX_OUTPUT);
  };
  try {
    await writeFile(path.join(isolated.game, "zz_ohmygame_live_adapter.rpy"), adapterSource(), "utf8");
    session.child = spawn(command.executable, [...command.prefixArgs, "--savedir", isolated.savedir, isolated.root], {
      cwd: isolated.root,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ...options.env,
        RENPY_DISABLE_BACKUPS: "I take responsibility for this.",
        RENPY_PATH_TO_SAVES: path.join(isolated.root, "env-saves"),
        RENPY_MULTIPERSISTENT: path.join(isolated.root, "multi-persistent"),
        OHMYGAME_LIVE_ENDPOINT: isolated.endpoint,
        OHMYGAME_LIVE_CAPTURE_DIR: isolated.capture,
        OHMYGAME_LIVE_TOKEN: token,
        OHMYGAME_LIVE_LABEL: options.label ?? "start",
      },
    });
    session.child.stdout.on("data", append);
    session.child.stderr.on("data", append);
    session.child.once("exit", (code) => { session.exitCode = code; session.closed = true; for (const pending of session.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error(`Ren'Py exited (${code})`)); } session.pending.clear(); });
    await waitForEndpoint(session);
    session.socket = await connect(session);
    session.socket.on("data", (chunk) => {
      session.buffer = (session.buffer ?? "") + chunk.toString("utf8");
      while (true) {
        const index = session.buffer.indexOf("\n");
        if (index < 0) break;
        const line = session.buffer.slice(0, index);
        session.buffer = session.buffer.slice(index + 1);
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        const pending = session.pending.get(message.id);
        if (!pending) continue;
        session.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.ok === true) pending.resolve(message.value);
        else pending.reject(new Error(typeof message.error === "string" ? message.error : "The Ren'Py playtest adapter rejected the request"));
      }
    });
    session.socket.once("close", () => { session.closed = true; });
    session.socket.once("error", () => {});
    const initial = sanitizeState(await request(session, "inspect"));
    let state = initial;
    if (initial.status === "main_menu") {
      try {
        await request(session, "start", { label: options.label ?? "start" });
      } catch (error) {
        if (!/JumpOutException/i.test(error instanceof Error ? error.message : String(error))) throw error;
      }
      state = sanitizeState(await waitForGame(session));
      if (state.status === "main_menu") throw new Error("Ren'Py stayed at the main menu; the start label did not run");
    }
    sessions.set(session.id, session);
    return { session: session.id, viewport: state.viewport, gameState: state };
  } catch (error) {
    await stopSession(session).catch(() => {});
    throw new Error(`${error instanceof Error ? error.message : String(error)}${session.output ? ` Output: ${session.output}` : ""}`);
  }
}

async function stopSession(session) {
  if (!session) return;
  try {
    if (session.socket && !session.closed) {
      await request(session, "close").catch(() => {});
      session.socket.destroy();
    }
  } finally {
    if (session.child && session.exitCode === undefined) {
      session.child.kill();
      await Promise.race([new Promise((resolve) => session.child.once("exit", resolve)), sleep(2_000)]);
      if (session.exitCode === undefined) session.child.kill("SIGKILL");
    }
    sessions.delete(session.id);
    await rm(session.root, { recursive: true, force: true }).catch(() => {});
  }
}

function validateAction(action) {
  if (!action || typeof action !== "object" || Array.isArray(action)) throw new Error("Invalid playtest action");
  if (action.type === "advance") {
    if (action.interactionId !== undefined && (typeof action.interactionId !== "string" || action.interactionId.length > MAX_INTERACTION_ID))
      throw new Error("Invalid interactionId for advance");
    return;
  }
  if (action.type === "choose") {
    if (typeof action.choiceId !== "string" || !action.choiceId || action.choiceId.length > MAX_CHOICE_ID)
      throw new Error("choose needs a choiceId");
    if (typeof action.interactionId !== "string" || !action.interactionId || action.interactionId.length > MAX_INTERACTION_ID)
      throw new Error("choose needs the interactionId it was observed in");
    return;
  }
  if (action.type === "wait") {
    if (!Number.isInteger(action.milliseconds) || action.milliseconds < 0 || action.milliseconds > 5_000)
      throw new Error("wait needs milliseconds from 0 to 5000");
    return;
  }
  throw new Error(`This Ren'Py playtest does not support ${String(action.type)} actions`);
}

export async function interactiveGameUse(command, project, input, options = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid Ren'Py playtest request");
  const session = input.session === undefined ? undefined : sessions.get(String(input.session));
  if (input.operation === "open") return startSession(command, project, options);
  if (!session) throw new Error("The Ren'Py playtest session is no longer open");
  if (input.operation === "inspect") return { gameState: sanitizeState(await request(session, "inspect")) };
  if (input.operation === "act") {
    const actions = Array.isArray(input.actions) ? input.actions.slice(0, MAX_ACTIONS) : [];
    if (!actions.length) throw new Error("act needs at least one action");
    for (const action of actions) {
      validateAction(action);
      if (action.type === "wait") {
        await sleep(action.milliseconds);
        continue;
      }
      if (action.type === "advance") {
        await request(session, "advance", action.interactionId ? { interactionId: action.interactionId } : {});
        await sleep(300);
        continue;
      }
      await request(session, "choose", { choiceId: action.choiceId, interactionId: action.interactionId });
      await sleep(450);
    }
    return { gameState: sanitizeState(await request(session, "inspect")) };
  }
  if (input.operation === "capture") {
    if (typeof input.output !== "string" || !input.output) throw new Error("capture needs an output path");
    const file = path.join(session.capture, `capture-${randomUUID()}.png`);
    await request(session, "capture", { path: file });
    await copyFile(file, input.output);
    await rm(file, { force: true }).catch(() => {});
    return { notes: "Ren'Py engine-rendered screenshot from the live isolated session" };
  }
  if (input.operation === "close") {
    await stopSession(session);
    return {};
  }
  throw new Error(`The Ren'Py playtest runtime does not support ${String(input.operation)}`);
}

export async function closeAllInteractiveSessions() {
  await Promise.allSettled([...sessions.values()].map((session) => stopSession(session)));
}

process.once("exit", () => {
  for (const session of sessions.values()) {
    try { session.child?.kill(); } catch { /* nothing else can run now */ }
  }
});
