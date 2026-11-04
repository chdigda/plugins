import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const source = await readFile(new URL("./client.mjs", import.meta.url), "utf8");
const plain = (value) => JSON.parse(JSON.stringify(value));
const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

function createSnapshotStore(initial) {
  let value = initial;
  const listeners = new Set();
  return {
    getSnapshot: () => value,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    set(next) { value = next; for (const listener of listeners) listener(); },
  };
}

// A small contract fixture: no React, browser, npm installation, or real credentials needed.
class FormModelFixture {
  constructor(scope, specs, secrets = []) {
    this.scope = scope;
    this.specs = new Map(specs.map((spec) => [spec.field, spec]));
    this.secrets = new Map(secrets.map((spec) => [spec.field, spec]));
    this.staged = new Map();
    this.listeners = new Set();
    this.failed = false;
    this.saving = false;
    this.off = scope.subscribe(() => this.publish());
  }
  publish() { for (const listener of this.listeners) listener(); }
  bind(project) {
    const store = createSnapshotStore(project());
    this.listeners.add(() => store.set(project()));
    return store;
  }
  field(field) {
    const draft = this.staged.get(field);
    if (this.secrets.has(field)) return { text: draft?.text ?? "" };
    const spec = this.specs.get(field);
    return { text: draft?.text ?? spec.format(this.scope.getSnapshot().value?.[field]) };
  }
  plan() {
    const snapshot = this.scope.getSnapshot();
    return [...this.staged].flatMap(([field, draft]) => {
      if (this.secrets.has(field)) return draft.text.trim() ? [{ run: () => this.secrets.get(field).write(draft.text.trim()) }] : [];
      const spec = this.specs.get(field);
      if (draft.clear) return Object.hasOwn(snapshot.user ?? {}, field) ? [{ op: { op: "unset", path: [field] } }] : [];
      if (draft.text === spec.format(snapshot.value?.[field])) return [];
      const parsed = spec.parse(draft.text);
      return parsed ? [{ op: { op: "set", path: [field], value: parsed.value } }] : [{}];
    });
  }
  shell() {
    const snapshot = this.scope.getSnapshot();
    const plan = this.plan();
    return { available: snapshot.status === "ready", writable: snapshot.writable, dirty: !!plan.length,
      invalid: plan.some((item) => !item.op && !item.run), saving: this.saving, failed: this.failed };
  }
  actions() {
    const stage = (field, draft) => {
      this.baseline ??= this.scope.getSnapshot().revision;
      this.staged.set(field, draft);
      this.failed = false;
      this.publish();
    };
    return {
      edit: (field, text) => stage(field, { text }),
      resetField: (field) => stage(field, { text: this.specs.get(field).format(this.scope.getSnapshot().base?.[field]), clear: true }),
      discard: () => { this.staged.clear(); this.baseline = undefined; this.failed = false; this.publish(); },
    };
  }
  async save() {
    const plan = this.plan();
    if (!plan.length || this.saving || !this.scope.getSnapshot().writable || this.shell().invalid) return;
    this.saving = true;
    this.failed = false;
    this.publish();
    try {
      const ops = plan.flatMap((item) => item.op ? [item.op] : []);
      let accepted = !ops.length || await this.scope.mutate(ops, this.baseline);
      if (accepted) for (const item of plan) if (item.run) accepted = await item.run() && accepted;
      this.failed = !accepted;
      if (accepted) { this.staged.clear(); this.baseline = undefined; }
    } catch { this.failed = true; }
    finally { this.saving = false; this.publish(); }
  }
  dispose() { this.off(); this.listeners.clear(); }
}

// Optional integration mode executes the actual installed shell's form model instead
// of the fixture. Set DSH_TEST_WEB_SHELL to its dist/assets/index-*.js path.
let SettingsFormModel = FormModelFixture;
if (process.env.DSH_TEST_WEB_SHELL) {
  const shell = await readFile(process.env.DSH_TEST_WEB_SHELL, "utf8");
  const start = shell.search(/var [A-Za-z_$][\w$]*=class[{]scope;specs;/);
  assert.notEqual(start, -1, "Find the installed native SettingsFormModel");
  const end = shell.indexOf("}};const ", start);
  assert.notEqual(end, -1, "Find the native model declaration boundary");
  const expression = shell.slice(shell.indexOf("=", start) + 1, end + 2);
  const storeName = expression.match(/bind[(][^)]*[)][{]const [^=]+=([^()]+)[(]/)?.[1];
  assert.ok(storeName, "Find the native model snapshot store dependency");
  SettingsFormModel = vm.runInNewContext("(" + expression + ")", { [storeName]: createSnapshotStore });
}

function makeScope(value, { base = value, user = {}, status = "ready", writable = true } = {}) {
  const store = createSnapshotStore({ status, writable, value, base, user, revision: 1 });
  const calls = [];
  return {
    ...store,
    calls,
    accepts: true,
    update(patch) { store.set({ ...store.getSnapshot(), ...patch }); },
    async mutate(ops, revision) {
      calls.push(plain({ ops, revision }));
      if (!this.accepts) return false;
      const previous = store.getSnapshot();
      const user = { ...previous.user };
      for (const op of ops) {
        if (op.op === "unset") delete user[op.path[0]];
        else user[op.path[0]] = op.value;
      }
      store.set({ ...previous, user, value: { ...previous.base, ...user }, revision: previous.revision + 1 });
      return true;
    },
  };
}

function loadPlugin() {
  let definition;
  const styles = [];
  const document = {
    createElement: () => ({ dataset: {}, remove() { styles.splice(styles.indexOf(this), 1); } }),
    head: { appendChild: (node) => styles.push(node) },
  };
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load: (value) => { definition = value; } } }, document });
  assert.equal(definition.id, "dsh-web-search");
  const primitives = { SettingsForm: () => {}, SettingsSecretField: () => {}, SettingsFormModel,
    settingsTextField: (field) => ({ field, format: (value) => typeof value === "string" ? value : "" }) };
  const jsx = (type, props, key) => ({ type, props, key });
  const modules = {
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "@deepseek-ai/dsh-client-ui-primitives": primitives,
    "@deepseek-ai/dsh-client-store": { createSnapshotStore },
  };
  return { ...definition.factory((name) => {
    assert.ok(modules[name], "Use only native browser runtime dependencies");
    return modules[name];
  }), primitives, styles };
}

function setup(options = {}) {
  const plugin = loadPlugin();
  const provider = makeScope({ tavilyApiKeyEnv: "TAVILY_API_KEY", braveApiKeyEnv: "BRAVE_SEARCH_API_KEY", ...options.config }, options.provider);
  const web = makeScope({ searchProvider: "tavily-brave", fetchProvider: "http", ...options.webValue }, options.web);
  const calls = [];
  const metadata = {
    TAVILY_API_KEY: { configured: true, writable: true },
    BRAVE_SEARCH_API_KEY: { configured: false, writable: true },
    ...options.metadata,
  };
  const ctx = { remote: { credentials: {
    async describe(refs) {
      calls.push(["describe", ...refs]);
      return options.describe ? options.describe(refs) : { ok: true, value: Object.fromEntries(refs.map((ref) => [ref, metadata[ref] ?? { configured: false, writable: true }])) };
    },
    async unset(ref) {
      calls.push(["unset", ref]);
      metadata[ref] = { configured: false, writable: true };
      return { ok: true };
    },
    async set(ref, value) {
      calls.push(["set", ref, value]);
      const response = options.set ? await options.set(ref, value) : { ok: true };
      if (response.ok) metadata[ref] = { configured: true, writable: true };
      return response;
    },
  } } };
  const card = new plugin.WebSearchCardController({ provider, web }, ctx);
  return { plugin, provider, web, ctx, calls, metadata, card };
}

const stateOf = (card) => card.store.getSnapshot();

test("factory loads without a build and never preloads a stored key", async () => {
  const { card, calls } = setup({ metadata: { TAVILY_API_KEY: { configured: true, writable: true, value: "EXISTING-SECRET" } } });
  await tick();
  assert.deepEqual(calls, [["describe", "TAVILY_API_KEY", "BRAVE_SEARCH_API_KEY"]]);
  assert.equal(stateOf(card).keyFields.tavilyApiKey.text, "");
  assert.equal(stateOf(card).keyFields.tavilyApiKey.configured, true);
  assert.equal(JSON.stringify(stateOf(card)).includes("EXISTING-SECRET"), false);
  assert.equal(stateOf(card).dirty, false);
  card.dispose();
});

test("both keys save via credentials only before the search selection", async () => {
  const { card, provider, web, calls } = setup();
  await tick();
  card.editKey("tavilyApiKey", "  NEW-TAVILY  ");
  card.editKey("braveApiKey", "NEW-BRAVE");
  card.select("brave");
  assert.equal(calls.filter(([kind]) => kind === "set").length, 0);
  await card.save();
  assert.deepEqual(calls.filter(([kind]) => kind === "set"), [["set", "TAVILY_API_KEY", "NEW-TAVILY"], ["set", "BRAVE_SEARCH_API_KEY", "NEW-BRAVE"]]);
  assert.deepEqual(provider.calls, []);
  assert.deepEqual(web.calls, [{ ops: [{ op: "set", path: ["searchProvider"], value: "brave" }], revision: 1 }]);
  assert.equal(web.getSnapshot().value.fetchProvider, "http");
  assert.equal(stateOf(card).keyFields.tavilyApiKey.text, "");
  assert.equal(stateOf(card).keyFields.braveApiKey.text, "");
  assert.equal(stateOf(card).dirty, false);
  card.dispose();
});

test("blank credentials preserve existing keys and never unset anything", async () => {
  const { card, calls, web } = setup();
  await tick();
  card.editKey("tavilyApiKey", "   ");
  card.editKey("braveApiKey", "");
  card.select("tavily");
  await card.save();
  assert.equal(calls.some(([kind]) => kind === "set"), false);
  assert.equal(web.getSnapshot().value.searchProvider, "tavily");
  card.dispose();
});

test("refused or thrown credential writes keep the draft and do not switch providers", async () => {
  for (const set of [async () => ({ ok: false, error: { message: "SECRET-MUST-NOT-BE-SHOWN" } }), async () => { throw Error("SECRET-MUST-NOT-BE-SHOWN"); }]) {
    const { card, web } = setup({ set });
    await tick();
    card.editKey("tavilyApiKey", "NEW-KEY");
    card.select("brave");
    await card.save();
    assert.equal(stateOf(card).failed, true);
    assert.equal(stateOf(card).saving, false);
    assert.equal(stateOf(card).keyFields.tavilyApiKey.text, "NEW-KEY");
    assert.equal(JSON.stringify(stateOf(card)).includes("SECRET-MUST-NOT-BE-SHOWN"), false);
    assert.deepEqual(web.calls, []);
    card.dispose();
  }
});

test("selection defaults clear an override and never patch fetchProvider", async () => {
  const { card, web } = setup({ webValue: { searchProvider: "brave" }, web: {
    base: { searchProvider: "tavily-brave", fetchProvider: "http" }, user: { searchProvider: "brave" },
  } });
  await tick();
  card.select("tavily-brave");
  await card.save();
  assert.deepEqual(web.calls[0].ops, [{ op: "unset", path: ["searchProvider"] }]);
  assert.equal(web.getSnapshot().value.searchProvider, "tavily-brave");
  card.select("untrusted-provider");
  await card.save();
  assert.equal(web.calls.length, 1);
  card.dispose();
});

test("read-only credentials and namespaces cannot be edited or saved", async () => {
  const first = setup({ metadata: { TAVILY_API_KEY: { configured: true, writable: false } } });
  await tick();
  first.card.editKey("tavilyApiKey", "FORBIDDEN");
  assert.equal(stateOf(first.card).keyFields.tavilyApiKey.text, "");
  assert.equal(stateOf(first.card).keyFields.tavilyApiKey.readOnly, true);
  first.card.dispose();
  const second = setup({ provider: { writable: false }, web: { writable: false } });
  await tick();
  second.card.editKey("braveApiKey", "FORBIDDEN");
  second.card.select("brave");
  await second.card.save();
  assert.equal(second.calls.some(([kind]) => kind === "set"), false);
  assert.deepEqual(second.web.calls, []);
  second.card.dispose();
});

test("keys can be configured when only the web selector namespace is absent", async () => {
  const { card, web, calls } = setup({ web: { status: "unavailable", writable: false } });
  await tick();
  card.editKey("braveApiKey", "NEW-KEY");
  card.select("brave");
  await card.save();
  assert.equal(stateOf(card).selectionAvailable, false);
  assert.equal(calls.some(([kind]) => kind === "set"), true);
  assert.deepEqual(web.calls, []);
  card.dispose();
});

test("failed credential status is unknown, retryable, and never displays error text", async () => {
  let fails = true;
  const { card } = setup({ describe: async (refs) => {
    if (fails) throw Error("HOST-SECRET");
    return { ok: true, value: Object.fromEntries(refs.map((ref) => [ref, { configured: false, writable: true }])) };
  } });
  await tick();
  assert.equal(stateOf(card).keyFields.tavilyApiKey.configured, null);
  assert.equal(stateOf(card).keyFields.tavilyApiKey.error, true);
  assert.equal(stateOf(card).keyFields.tavilyApiKey.writable, false);
  assert.equal(JSON.stringify(stateOf(card)).includes("HOST-SECRET"), false);
  fails = false;
  await card.inject().retry();
  assert.equal(stateOf(card).keyFields.tavilyApiKey.error, false);
  assert.equal(stateOf(card).keyFields.tavilyApiKey.writable, true);
  card.dispose();
});

test("custom references are honored and ref changes erase unsaved key drafts", async () => {
  const { card, provider, calls } = setup({ config: { tavilyApiKeyEnv: "CUSTOM_TAVILY" } });
  await tick();
  assert.equal(calls[0][1], "CUSTOM_TAVILY");
  card.editKey("tavilyApiKey", "DO-NOT-RETARGET");
  provider.update({ value: { ...provider.getSnapshot().value, tavilyApiKeyEnv: "OTHER_TAVILY" } });
  await tick();
  assert.equal(stateOf(card).keyFields.tavilyApiKey.text, "");
  assert.equal(stateOf(card).referencesChanged, true);
  await card.save();
  assert.equal(calls.some(([kind]) => kind === "set"), false);
  card.dispose();
});

test("old and out-of-order status responses cannot overwrite the current badge", async () => {
  const requests = [];
  const { card, provider } = setup({ describe: (refs) => {
    const pending = deferred(); requests.push({ refs, ...pending }); return pending.promise;
  } });
  provider.update({ value: { tavilyApiKeyEnv: "NEW_REF", braveApiKeyEnv: "BRAVE_SEARCH_API_KEY" } });
  requests[1].resolve({ ok: true, value: { NEW_REF: { configured: true, writable: true } } });
  await tick();
  requests[0].resolve({ ok: true, value: { TAVILY_API_KEY: { configured: false, writable: false }, BRAVE_SEARCH_API_KEY: { configured: false, writable: true } } });
  await tick();
  assert.equal(stateOf(card).keyFields.tavilyApiKey.configured, true);
  const older = card.readCredentials(["tavilyApiKey"]);
  const newer = card.readCredentials(["tavilyApiKey"]);
  requests[3].resolve({ ok: true, value: { NEW_REF: { configured: false, writable: true } } });
  await newer;
  requests[2].resolve({ ok: true, value: { NEW_REF: { configured: true, writable: true } } });
  await older;
  assert.equal(stateOf(card).keyFields.tavilyApiKey.configured, false);
  card.dispose();
});

test("double saves are ignored and drafts are cleared on unmount/dispose", async () => {
  const pending = deferred();
  const { card, calls, provider } = setup({ set: () => pending.promise });
  await tick();
  card.editKey("tavilyApiKey", "NEW-KEY");
  const save = card.save();
  await card.save();
  assert.equal(calls.filter(([kind]) => kind === "set").length, 1);
  assert.equal(stateOf(card).saving, true);
  pending.resolve({ ok: true });
  await save;
  card.editKey("braveApiKey", "DRAFT");
  provider.update({ status: "unavailable" });
  assert.equal(stateOf(card).keyFields.braveApiKey.text, "");
  card.dispose();
  assert.equal(card.keys.field("braveApiKey").text, "");
});

test("native secret fields and accessible selector receive only new text and safe metadata", async () => {
  const { card, plugin } = setup({ webValue: { searchProvider: "some-other-provider" } });
  await tick();
  const face = card.inject();
  const tree = plugin.WebSearchCard({ ...face, t: (key) => key,
    useWebSearchCard: (selector) => selector(stateOf(card)), view: "settings" });
  assert.equal(tree.type, plugin.primitives.SettingsForm);
  const children = tree.props.children.flatMap(child => child?.type === "div" ? [child, ...child.props.children] : [child]);
  const secrets = children.filter((child) => child?.type === plugin.primitives.SettingsSecretField);
  assert.equal(secrets.length, 2);
  assert.deepEqual(plain(secrets.map((child) => child.props.text)), ["", ""]);
  const selector = children.find(child => child?.type === "select");
  assert.equal(selector.props["aria-describedby"], "plugin-config-web-search-search-hint");
  assert.deepEqual(plain(selector.props.children.filter(Boolean).map((child) => child.props.value)), ["some-other-provider", "tavily-brave", "brave-tavily", "tavily", "brave"]);
  assert.equal(tree.props.onDiscard, face.discard);
  card.dispose();
});

test("Plugins slot mounts only while the Host namespace is served and cleans up effects", async () => {
  const { plugin, ctx, provider, web, calls } = setup();
  const disposers = [];
  const events = new Map();
  let registration;
  let served;
  ctx.locale = { bind: () => (key) => key, register: (_namespace, dictionaries) => {
    assert.ok(dictionaries.en && dictionaries.ko && dictionaries.zh); return () => {};
  } };
  ctx.effect = (effect) => { const off = effect(); if (off) disposers.push(off); };
  ctx.on = (event, listener) => { events.set(event, listener); return () => events.delete(event); };
  ctx.remote.$on = ctx.on;
  ctx.configForms = {
    get: (namespace) => namespace === "web" ? web : provider,
    whileServed: (names, mount) => { served = plain(names); return mount(); },
  };
  ctx.slots = {
    inject: (name, mount) => { assert.equal(name, "plugins.bundle.config"); return mount(); },
    register: (options, component) => { registration = { options, component }; return () => { registration = undefined; }; },
  };
  plugin.apply(ctx);
  await tick();
  assert.deepEqual(served, ["web-search"]);
  assert.equal(registration.options.name, "plugins.bundle.config");
  assert.equal(registration.options.key, "dsh-web-search");
  assert.equal(registration.component, plugin.WebSearchCard);
  assert.equal(plugin.styles.length, 1);
  const reads = calls.length;
  events.get("credentials/reference-updated")("UNRELATED_REF");
  assert.equal(calls.length, reads);
  events.get("credentials/reference-updated")("TAVILY_API_KEY");
  await tick();
  assert.equal(calls.length, reads + 1);
  assert.deepEqual(calls.at(-1), ["describe", "TAVILY_API_KEY"]);
  events.get("connection/reset")();
  await tick();
  assert.deepEqual(calls.at(-1), ["describe", "TAVILY_API_KEY", "BRAVE_SEARCH_API_KEY"]);
  for (const off of disposers.reverse()) off();
  assert.equal(registration, undefined);
  assert.equal(plugin.styles.length, 0);
  assert.equal(events.size, 0);
});

test("provider switches persist and stored keys can be deleted independently", async () => {
  const { card, provider, calls } = setup();
  await tick();
  card.editEnabled("tavilyEnabled", false);
  await card.save();
  assert.equal(provider.getSnapshot().value.tavilyEnabled, false);
  assert.equal(stateOf(card).providers.braveEnabled, true);
  await card.removeKey("tavilyApiKey");
  assert.equal(stateOf(card).keyFields.tavilyApiKey.configured, false);
  assert.deepEqual(calls.filter(([kind]) => kind === "unset"), [["unset", "TAVILY_API_KEY"]]);
  card.dispose();
});
