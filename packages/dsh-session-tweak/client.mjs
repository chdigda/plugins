window.__ModuleLoader__.load({
  id: "dsh-session-tweak",
  factory(require) {
    const React = require("react");
    const { createPortal } = require("react-dom");
    const { IconEditOutlineRegular, IconTrashOutlineRegular } = require("@deepseek-ai/dsh-client-ui-primitives");
    const h = React.createElement;
    const NS = "sessionTweak";
    const en = {
      edit: "Edit", delete: "Delete", save: "Save", cancel: "Cancel", loading: "Loading…",
      busy: "This session is running. Wait until it finishes to edit or delete.",
      restart: "Restart DSH to edit messages in this session opened before the plugin was loaded.",
      unavailable: "This message cannot be changed.",
      "error.stale": "This message changed. Cancel and try again.",
      "error.compacted": "This message is already covered by a context summary and cannot be edited here.",
      "error.binding-unavailable": "This session cannot be updated in place. Reopen it and try again.",
      "error.session-busy": "This session is running. Wait until it finishes to edit or delete.",
      "error.target-not-found": "Message not found. Try again.",
      "error.session-not-found": "Session not found.",
      "error.text-invalid": "Enter message text.",
      "error.text-too-large": "The message text is too large.",
      "error.network": "Could not reach the server.",
      "error.timeout": "The request timed out. Try again.",
      "error.bad-response": "Could not read the server response.",
      "error.generic": "Could not change the message. Try again."
    };
    const ko = {
      edit: "수정", delete: "삭제", save: "저장", cancel: "취소", loading: "불러오는 중…",
      busy: "세션이 실행 중입니다. 끝난 뒤에 수정하거나 삭제하세요.",
      restart: "플러그인을 불러오기 전에 열린 세션입니다. 메시지를 수정하려면 DSH를 재시작하세요.",
      unavailable: "이 메시지는 변경할 수 없습니다.",
      "error.stale": "메시지가 변경되었습니다. 취소한 뒤 다시 시도하세요.",
      "error.compacted": "이미 컨텍스트 요약에 포함된 메시지는 여기서 수정할 수 없습니다.",
      "error.binding-unavailable": "이 세션은 화면에서 바로 갱신할 수 없습니다. 세션을 다시 연 뒤 시도하세요.",
      "error.session-busy": "세션이 실행 중입니다. 끝난 뒤에 수정하거나 삭제하세요.",
      "error.target-not-found": "메시지를 찾을 수 없습니다. 다시 시도하세요.",
      "error.session-not-found": "세션을 찾을 수 없습니다.",
      "error.text-invalid": "메시지 내용을 입력하세요.",
      "error.text-too-large": "메시지가 너무 깁니다.",
      "error.network": "서버에 연결하지 못했습니다.",
      "error.timeout": "요청 시간이 초과되었습니다. 다시 시도하세요.",
      "error.bad-response": "서버 응답을 읽지 못했습니다.",
      "error.generic": "메시지를 변경하지 못했습니다. 다시 시도하세요."
    };
    const css =
      ".st_inlineActions{display:inline-flex;align-items:center;gap:8px}.st_action{width:calc(28px + var(--dsh-content-font-delta,0px));height:calc(28px + var(--dsh-content-font-delta,0px));border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-tertiary);cursor:pointer;background:transparent;border:0;display:inline-flex;align-items:center;justify-content:center;padding:6px}.st_action svg{width:17px;height:17px}.st_action:disabled{cursor:default;opacity:.4}.st_action:not(:disabled):hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}.st_inlinePanel{display:block;width:100%;min-width:0;margin:4px 0}.st_editor{display:flex;flex-direction:column;gap:8px;width:100%;min-width:min(280px,100%)}.st_textarea{box-sizing:border-box;width:100%;min-height:100px;resize:vertical;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);padding:10px;font:inherit;line-height:1.55}.st_textarea:focus-visible{outline:1px solid var(--dsw-alias-border-l3)}.st_editorActions{display:flex;justify-content:flex-end;gap:8px}.st_editorButton{font:inherit;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover);border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);padding:4px 12px;cursor:pointer}.st_editorButton:disabled{opacity:.4;cursor:default}.st_note{margin:4px 0;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}.st_error{color:var(--dsw-alias-state-error-primary)}";
    function apiError(code, message) {
      return Object.assign(new Error(message || code), { code });
    }
    async function request(path, init, controller) {
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 15000);
      try {
        const response = await fetch("/plugin-session-tweak" + path, {
          ...init, credentials: "same-origin", cache: "no-store", signal: controller.signal
        });
        let body;
        try { body = await response.json(); } catch { throw apiError("bad-response"); }
        if (body?.ok === false) throw apiError(body.error?.code || "generic", body.error?.message);
        if (!response.ok || body?.ok !== true || !body.value) throw apiError("bad-response");
        return body.value;
      } catch (error) {
        if (timedOut) throw apiError("timeout");
        if (controller.signal.aborted) throw error;
        throw error.code ? error : apiError("network");
      } finally { clearTimeout(timer); }
    }
    function messageIdOf(node) {
      if (node?.kind === "assistant-step") return node.data?.finalNode?.messageId;
      if (node?.kind === "turn-tail") return node.data?.closing?.finalNode?.messageId;
      if (node?.kind === "user" || node?.kind === "steering") return node.data?.messageId;
      return undefined;
    }
    function snapshotEntries(snapshot) {
      if (snapshot === null || typeof snapshot !== "object" || typeof snapshot.sessionId !== "string" || snapshot.sessionId === "" || !Array.isArray(snapshot.events)) throw apiError("bad-response");
      const entries = [];
      for (const event of snapshot.events) {
        if (event === null || typeof event !== "object" || typeof event.type !== "string" || typeof event.seq !== "number" || !Number.isFinite(event.seq)) throw apiError("bad-response");
        entries.push({ type: "event", event });
      }
      entries.sort((left, right) => left.event.seq - right.event.seq);
      let projections;
      const raw = snapshot.projections;
      if (raw !== null && typeof raw === "object" && typeof raw.asOfSeq === "number" && Number.isFinite(raw.asOfSeq) && raw.values !== null && typeof raw.values === "object") projections = { asOfSeq: raw.asOfSeq, values: raw.values };
      let epoch = typeof snapshot.epoch === "string" && snapshot.epoch !== "" ? snapshot.epoch : null;
      let version = typeof snapshot.version === "number" && Number.isSafeInteger(snapshot.version) && snapshot.version >= 0 ? snapshot.version : null;
      if ((epoch === null || version === null) && typeof snapshot.revision === "string") {
        const colon = snapshot.revision.lastIndexOf(":");
        if (colon > 0) {
          if (epoch === null) epoch = snapshot.revision.slice(0, colon) || null;
          if (version === null) {
            const parsed = Number(snapshot.revision.slice(colon + 1));
            if (Number.isSafeInteger(parsed) && parsed >= 0) version = parsed;
          }
        }
      }
      return { sessionId: snapshot.sessionId, entries, projections, epoch, version };
    }
    function locate(anchor, nodes, messageId, suppliedRow) {
      const root = anchor?.closest("[data-conversation-session]");
      if (!root) return null;
      let row = suppliedRow;
      if (!row || !root.contains(row)) {
        row = Array.from(root.querySelectorAll("[data-chat-node-key]")).find((element) => {
          const node = nodes.get(element.dataset.chatNodeKey);
          return node?.kind === "assistant-step" && messageIdOf(node) === messageId && element.closest('[data-chat-group-part="reasoning"]') === null;
        });
      }
      row = row || anchor.closest("[data-chat-node-key]") || anchor.parentElement;
      if (!row) return null;
      const bubble = row.querySelector("[data-message-bubble]");
      const bodies = bubble ? [bubble] : Array.from(row.querySelectorAll("[data-text-interaction-source]")).filter((element) => !element.closest('[data-variant="think"]'));
      return { row, bodies };
    }
    function InlinePanel({ anchor, nodes, messageId, row, editing, children }) {
      const [mount, setMount] = React.useState(null);
      React.useLayoutEffect(() => {
        const location = locate(anchor.current, nodes, messageId, row);
        if (!location) return;
        const element = document.createElement("div");
        element.dataset.stOwned = "panel";
        element.className = "st_inlinePanel";
        const first = location.bodies[0];
        if (first?.parentElement) first.parentElement.insertBefore(element, first);
        else location.row.appendChild(element);
        const previous = editing ? location.bodies.map((body) => ({ body, hidden: body.hidden, display: body.style.getPropertyValue("display"), priority: body.style.getPropertyPriority("display") })) : [];
        for (const { body } of previous) { body.hidden = true; body.style.setProperty("display", "none", "important"); }
        setMount(element);
        return () => {
          for (const { body, hidden, display, priority } of previous) {
            body.hidden = hidden;
            if (display) body.style.setProperty("display", display, priority);
            else body.style.removeProperty("display");
          }
          element.remove();
        };
      }, [anchor, nodes, messageId, row, editing]);
      return mount ? createPortal(children, mount) : null;
    }
    function EditDelete({ sessionId, messageId, useSessionStatus, nodes, row, t, native = false, applySnapshot }) {
      const running = useSessionStatus((state) => state.get(sessionId)?.running === true);
      const liveRunning = React.useRef(running);
      liveRunning.current = running;
      const anchor = React.useRef(null);
      const active = React.useRef(null);
      const alive = React.useRef(true);
      const [pending, setPending] = React.useState(false);
      const [edit, setEdit] = React.useState(null);
      const [notice, setNotice] = React.useState(null);
      React.useEffect(() => {
        alive.current = true;
        return () => { alive.current = false; active.current?.abort(); active.current = null; };
      }, [sessionId, messageId]);
      const describe = (error) => {
        if (error.code === "restart-required") return t("restart");
        const key = "error." + error.code;
        return en[key] ? t(key) : error.message || t("error.generic");
      };
      const perform = async (work) => {
        if (liveRunning.current || active.current) return;
        const controller = new AbortController();
        active.current = controller;
        setPending(true);
        setNotice(null);
        try { await work(controller); }
        catch (error) {
          if (alive.current && active.current === controller && (!controller.signal.aborted || error.code === "timeout")) {
            setEdit(null);
            setNotice(describe(error));
          }
        } finally {
          if (alive.current && active.current === controller) { active.current = null; setPending(false); }
        }
      };
      const mutate = async (kind, revision, text, controller) => {
        if (liveRunning.current) throw apiError("session-busy");
        if (typeof applySnapshot !== "function") throw apiError("binding-unavailable");
        const value = await request("/" + kind, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId, messageId, revision, ...(kind === "edit" ? { text } : {}) })
        }, controller);
        if (!alive.current || controller.signal.aborted) return;
        if (value === null || typeof value !== "object" || value.updated !== true || value.sessionId !== sessionId) throw apiError("bad-response");
        applySnapshot(value);
        setEdit(null);
      };
      const open = (kind) => perform(async (controller) => {
        setEdit(null);
        const value = await request("/message?session=" + encodeURIComponent(sessionId) + "&message=" + encodeURIComponent(messageId), { method: "GET" }, controller);
        if (!alive.current || controller.signal.aborted) return;
        if (value.running || liveRunning.current) throw apiError("session-busy");
        if (!value.editable) throw apiError(value.reason || "not-editable", value.reason === "restart-required" ? t("restart") : t("unavailable"));
        if (value.message?.messageId !== messageId || typeof value.message.text !== "string" || value.revision === undefined) throw apiError("bad-response");
        if (kind === "delete") await mutate(kind, value.revision, undefined, controller);
        else setEdit({ revision: value.revision, text: value.message.text });
      });
      const cancel = () => {
        active.current?.abort();
        active.current = null;
        setPending(false);
        setEdit(null);
        setNotice(null);
      };
      const save = () => {
        if (!edit || !edit.text.trim()) return;
        perform((controller) => mutate("edit", edit.revision, edit.text, controller));
      };
      const disabled = running || pending;
      const button = (kind, Icon) => h("button", {
        type: "button", className: "st_action", disabled,
        "aria-label": t(kind), title: running ? t("busy") : t(kind),
        onClick: () => open(kind)
      }, h(Icon, { size: 17 }));
      return h(React.Fragment, null,
        h("span", { ref: anchor, className: "st_inlineActions", "data-st-native": native ? messageId : undefined, "data-st-owned": "actions", "aria-busy": pending || undefined },
          button("edit", IconEditOutlineRegular), button("delete", IconTrashOutlineRegular)),
        edit || notice || pending ? h(InlinePanel, { anchor, nodes, messageId, row, editing: !!edit },
          edit ? h("div", { className: "st_editor", onKeyDown: (event) => {
            if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (!pending) cancel(); }
            else if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); save(); }
          } },
            h("textarea", { className: "st_textarea", "aria-label": t("edit"), value: edit.text, rows: 5, autoFocus: true, disabled,
              onChange: (event) => setEdit({ ...edit, text: event.target.value }) }),
            running ? h("p", { className: "st_note", role: "status" }, t("busy")) : null,
            h("div", { className: "st_editorActions" },
              h("button", { type: "button", className: "st_editorButton", disabled, onClick: cancel }, t("cancel")),
              h("button", { type: "button", className: "st_editorButton", disabled: disabled || !edit.text.trim(), onClick: save }, t("save")))) : null,
          notice ? h("div", null, h("p", { className: "st_note st_error", role: "alert" }, notice),
            h("button", { type: "button", className: "st_editorButton", onClick: cancel }, t("cancel"))) : null,
          pending ? h("p", { className: "st_note", role: "status" }, t("loading")) : null) : null);
    }
    function NativeActions(props) {
      const nodes = props.useChat((state) => state.nodes);
      return h(EditDelete, { ...props, nodes, native: true });
    }
    function InlinePortals(props) {
      const { sessionId, useChat, retainSnapshots } = props;
      const nodes = useChat((state) => state.nodes);
      const order = useChat((state) => state.order);
      const anchor = React.useRef(null);
      const [entries, setEntries] = React.useState([]);
      React.useEffect(() => {
        const root = anchor.current?.closest("[data-conversation-session]");
        if (!root) return;
        let disposed = false;
        let queued = false;
        let current = [];
        const mounts = new Map();
        const scan = () => {
          queued = false;
          if (disposed) return;
          const nativeIds = new Set(Array.from(root.querySelectorAll("[data-st-native]")).map((element) => element.dataset.stNative));
          const next = [];
          const seen = new Set();
          for (const row of root.querySelectorAll("[data-chat-node-key]")) {
            const node = nodes.get(row.dataset.chatNodeKey);
            const messageId = messageIdOf(node);
            if (typeof messageId !== "string" || !messageId || seen.has(messageId)) continue;
            const user = node.kind === "user" || node.kind === "steering";
            const assistant = node.kind === "assistant-step" && node.data?.finalNode && node.data?.blocks?.some((block) => block.kind === "text" && block.text.trim());
            if (!user && (!assistant || nativeIds.has(messageId) || row.closest('[data-chat-group-part="reasoning"]'))) continue;
            const target = user ? row.querySelector('[data-clock="start"]') : row.querySelector('[data-clock="end"]') || row;
            if (!target) continue;
            seen.add(messageId);
            let mount = mounts.get(row);
            if (!mount || mount.parentElement !== target) {
              mount?.remove();
              mount = document.createElement("span");
              mount.dataset.stOwned = "mount";
              mount.className = "st_inlineActions";
              target.appendChild(mount);
              mounts.set(row, mount);
            }
            next.push({ row, messageId, mount });
          }
          for (const [row, mount] of mounts) {
            if (!next.some((entry) => entry.mount === mount)) { mount.remove(); mounts.delete(row); }
          }
          if (current.length !== next.length || next.some((entry, index) => entry.row !== current[index].row || entry.messageId !== current[index].messageId || entry.mount !== current[index].mount)) {
            current = next;
            setEntries(next);
          }
        };
        const schedule = () => { if (!queued && !disposed) { queued = true; queueMicrotask(scan); } };
        const owned = (node) => node.nodeType === 1 ? node.hasAttribute("data-st-owned") || !!node.closest("[data-st-owned]") : !!node.parentElement?.closest("[data-st-owned]");
        const observer = new MutationObserver((records) => {
          if (records.some((record) => !owned(record.target) && Array.from(record.addedNodes).concat(Array.from(record.removedNodes)).some((node) => !owned(node) || node.nodeType === 1 && (node.hasAttribute("data-st-native") || node.querySelector("[data-st-native]"))))) schedule();
        });
        observer.observe(root, { childList: true, subtree: true });
        const unsubscribes = Array.from(order || []).map((key) => nodes.source(key).subscribe(schedule));
        scan();
        return () => {
          disposed = true;
          observer.disconnect();
          unsubscribes.forEach((unsubscribe) => unsubscribe());
          mounts.forEach((mount) => mount.remove());
        };
      }, [sessionId, nodes, order]);
      React.useEffect(() => {
        if (typeof retainSnapshots !== "function" || typeof sessionId !== "string" || sessionId === "") return;
        return retainSnapshots(sessionId);
      }, [retainSnapshots, sessionId]);
      return h(React.Fragment, null, h("span", { ref: anchor, hidden: true, "data-st-owned": "anchor" }),
        entries.map((entry) => createPortal(h(EditDelete, { ...props, nodes, row: entry.row, messageId: entry.messageId }), entry.mount, entry.messageId)));
    }
    function apply(ctx) {
      const channels = new Map();
      const channelFor = (sessionId) => {
        let channel = channels.get(sessionId);
        if (channel === undefined) {
          channel = { epoch: null, version: null, subscribers: 0, source: null, guard: null, authoritative: null };
          channels.set(sessionId, channel);
        }
        return channel;
      };
      const sequenceOf = (entry) => entry !== null && typeof entry === "object" && entry.event !== null && typeof entry.event === "object" && typeof entry.event.seq === "number" && Number.isFinite(entry.event.seq) ? entry.event.seq : null;
      const overlayEntry = (authoritative, entry) => {
        const seq = sequenceOf(entry);
        if (seq === null || authoritative === null) return entry;
        const known = authoritative.bySeq.get(seq);
        return known === undefined ? entry : known;
      };
      const increasing = (entries) => {
        let previous = null;
        for (const entry of entries) {
          const seq = sequenceOf(entry);
          if (seq === null) return false;
          if (previous !== null && seq <= previous) return false;
          previous = seq;
        }
        return true;
      };
      const projected = (projections, authoritative) => {
        if (authoritative === null || projections === null || typeof projections !== "object" || typeof projections.asOfSeq !== "number" || !Number.isFinite(projections.asOfSeq)) return projections;
        return projections.asOfSeq <= authoritative.lastSeq ? authoritative.projections : projections;
      };
      const guardedInstall = (guard, session, entries, hasMore, projections, assistantStream) => {
        const authoritative = guard.channel.authoritative;
        const incoming = Array.isArray(entries) ? entries : [];
        if (authoritative === null || authoritative.lastSeq < 0) return guard.originalInstallWindow.call(session, entries, hasMore, projections, assistantStream);
        const bySeq = new Map(authoritative.bySeq);
        const current = guard.eventSource?.getSnapshot?.().entries ?? [];
        for (const entry of current.concat(incoming)) {
          const seq = sequenceOf(entry);
          if (entry.type === "event" && seq !== null && seq > authoritative.lastSeq) bySeq.set(seq, entry);
        }
        const merged = bySeq.size === authoritative.bySeq.size ? authoritative.entries : [...bySeq.values()].sort((a, b) => sequenceOf(a) - sequenceOf(b));
        const last = sequenceOf(merged[merged.length - 1]);
        if (increasing(merged) && sequenceOf(merged[0]) === 0 && last + 1 === merged.length) {
          const baseline = projected(projections, authoritative);
          const currentBaseline = baseline && baseline.asOfSeq < last ? undefined : baseline;
          const incomingLast = sequenceOf(incoming[incoming.length - 1]);
          return guard.originalInstallWindow.call(session, merged, false, currentBaseline, incomingLast !== null && incomingLast >= last && last > authoritative.lastSeq ? assistantStream : undefined);
        }
        return guard.originalInstallWindow.call(session, incoming.map((entry) => overlayEntry(authoritative, entry)), hasMore, projected(projections, authoritative), assistantStream);
      };
      const guardedPrepend = (guard, session, entries, hasMore) => {
        const authoritative = guard.channel.authoritative;
        const incoming = Array.isArray(entries) ? entries : [];
        if (authoritative === null || authoritative.lastSeq < 0 || incoming.length === 0) return guard.originalPrependWindow.call(session, entries, hasMore);
        const baseSeq = typeof session.baseSeq === "number" && Number.isFinite(session.baseSeq) ? session.baseSeq : 0;
        const filtered = [];
        for (const entry of incoming) {
          const seq = sequenceOf(entry);
          if (seq === null || seq < 0 || seq >= baseSeq) continue;
          filtered.push(overlayEntry(authoritative, entry));
        }
        if (filtered.length === 0) return;
        return guard.originalPrependWindow.call(session, filtered, hasMore);
      };
      const releaseGuard = (channel) => {
        const guard = channel.guard;
        if (guard === null) return;
        channel.guard = null;
        const session = guard.session;
        if (guard.ownInstall === undefined) delete session.installWindow;
        else Object.defineProperty(session, "installWindow", guard.ownInstall);
        if (guard.ownPrepend === undefined) delete session.prependWindow;
        else Object.defineProperty(session, "prependWindow", guard.ownPrepend);
      };
      const ensureGuard = (sessionId) => {
        const channel = channelFor(sessionId);
        const binding = ctx.sessions.binding(sessionId);
        const session = binding === undefined || binding === null ? undefined : binding.session;
        if (session === undefined || session === null || typeof session.installWindow !== "function" || typeof session.prependWindow !== "function") return null;
        if (channel.guard !== null && channel.guard.session === session) return channel.guard;
        if (channel.guard !== null) releaseGuard(channel);
        const ownInstall = Object.getOwnPropertyDescriptor(session, "installWindow");
        const ownPrepend = Object.getOwnPropertyDescriptor(session, "prependWindow");
        const guard = {
          channel,
          session,
          eventSource: binding.eventSource,
          originalInstallWindow: session.installWindow,
          originalPrependWindow: session.prependWindow,
          ownInstall,
          ownPrepend
        };
        Object.defineProperty(session, "installWindow", {
          configurable: true,
          enumerable: false,
          writable: true,
          value: function (entries, hasMore, projections, assistantStream) {
            return guardedInstall(guard, this, entries, hasMore, projections, assistantStream);
          }
        });
        Object.defineProperty(session, "prependWindow", {
          configurable: true,
          enumerable: false,
          writable: true,
          value: function (entries, hasMore) {
            return guardedPrepend(guard, this, entries, hasMore);
          }
        });
        channel.guard = guard;
        return guard;
      };
      const remember = (channel, normalized) => {
        if (normalized.version === null || normalized.version <= 0 || normalized.entries.length === 0) return;
        const bySeq = new Map();
        for (const entry of normalized.entries) {
          const seq = sequenceOf(entry);
          if (seq !== null) bySeq.set(seq, entry);
        }
        channel.authoritative = {
          entries: normalized.entries,
          projections: normalized.projections,
          lastSeq: sequenceOf(normalized.entries[normalized.entries.length - 1]),
          bySeq
        };
      };
      const applySnapshot = (snapshot) => {
        const normalized = snapshotEntries(snapshot);
        const channel = channelFor(normalized.sessionId);
        if (normalized.epoch !== null && normalized.version !== null && channel.epoch === normalized.epoch && channel.version !== null && normalized.version <= channel.version) return false;
        const binding = ctx.sessions.binding(normalized.sessionId);
        const session = binding === undefined || binding === null ? undefined : binding.session;
        if (session === undefined || session === null) throw apiError("binding-unavailable");
        if (normalized.epoch !== null && channel.epoch !== null && normalized.epoch !== channel.epoch) channel.authoritative = null;
        const guard = channel.subscribers > 0 ? ensureGuard(normalized.sessionId) : channel.guard !== null && channel.guard.session === session ? channel.guard : null;
        const installWindow = guard === null ? session.installWindow : guard.originalInstallWindow;
        if (typeof installWindow !== "function") throw apiError("binding-unavailable");
        installWindow.call(session, normalized.entries, false, normalized.projections, undefined);
        if (normalized.epoch !== null) channel.epoch = normalized.epoch;
        if (normalized.version !== null) channel.version = normalized.version;
        remember(channel, normalized);
        return true;
      };
      const retainSnapshots = (sessionId) => {
        const channel = channelFor(sessionId);
        channel.subscribers += 1;
        ensureGuard(sessionId);
        if (channel.source === null && typeof globalThis.EventSource === "function") {
          let source = null;
          try {
            source = new globalThis.EventSource("/plugin-session-tweak/events?session=" + encodeURIComponent(sessionId));
          } catch (error) {
            source = null;
          }
          if (source !== null) {
            channel.source = source;
            const accept = (event) => {
              if (typeof event.data !== "string" || event.data === "") return;
              let snapshot;
              try {
                snapshot = JSON.parse(event.data);
              } catch (error) {
                return;
              }
              if (snapshot === null || typeof snapshot !== "object" || snapshot.sessionId !== sessionId) return;
              try {
                applySnapshot(snapshot);
              } catch (error) {}
            };
            source.addEventListener("snapshot", accept);
            source.addEventListener("message", accept);
          }
        }
        let released = false;
        return () => {
          if (released) return;
          released = true;
          channel.subscribers -= 1;
          if (channel.subscribers > 0) return;
          releaseGuard(channel);
          if (channel.source !== null) channel.source.close();
          channel.source = null;
          channels.delete(sessionId);
        };
      };
      ctx.effect(() => () => {
        for (const channel of channels.values()) {
          if (channel.source !== null) channel.source.close();
          releaseGuard(channel);
        }
        channels.clear();
      }, "session-tweak: live snapshot channels");
      ctx.effect(() => ctx.locale.register(NS, { ko, en }), "session-tweak: dictionaries");
      ctx.effect(() => {
        const style = document.createElement("style");
        style.dataset.pluginCss = "dsh-session-tweak/inline.css";
        style.textContent = css;
        document.head.appendChild(style);
        return () => style.remove();
      }, "session-tweak: inline styles");
      ctx.slots.inject("conversation.input.overlay", () => ctx.slots.register({ name: "conversation.input.overlay", id: "session-tweak-inline", locale: NS, inject: () => ({ applySnapshot, retainSnapshots }) }, InlinePortals));
      ctx.slots.inject("conversation.chat.assistant-actions", () => ctx.slots.register({ name: "conversation.chat.assistant-actions", id: "session-tweak", order: 30, locale: NS, inject: () => ({ applySnapshot }) }, NativeActions));
    }
    return { name: "session-tweak", inject: ["slots", "locale", "sessions"], apply };
  }
});
