window.__ModuleLoader__.load({
  id: "dsh-session-tweak",
  factory(require) {
    const React = require("react");
    const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
    const Modal = primitives.Modal;
    const Button = primitives.Button;
    const Tooltip = primitives.Tooltip;
    const IconEditOutlineRegular = primitives.IconEditOutlineRegular;
    const IconRefreshOutlineRegular = primitives.IconRefreshOutlineRegular;
    const h = React.createElement;
    const NS = "sessionTweak";
    const ENDPOINT = "/plugin-session-tweak";
    const TIMEOUT_MS = 15000;
    const MAX_TEXT_BYTES = 65536;
    const CSS_ID = "dsh-session-tweak/client.css";
    const KNOWN_ERROR_CODES = ["session-not-found", "session-busy", "target-not-found", "not-editable", "not-deletable", "stale", "text-invalid", "text-too-large", "internal", "bad-request", "unauthorized", "unavailable", "network", "timeout", "bad-response", "http"];
    const ko = {
      "open": "세션 트윅",
      "title": "세션 트윅",
      "hint": "다음 요청부터 모델이 보는 대화 내용을 바꿉니다. 화면의 원래 기록은 남습니다.",
      "close": "닫기",
      "refresh": "새로고침",
      "loading": "불러오는 중…",
      "empty": "표시할 메시지가 없습니다.",
      "busy": "이 세션은 실행 중입니다. 끝난 뒤에 수정하거나 삭제하세요.",
      "assistantEditUnsupported": "이 런타임에서는 봇 메시지 본문을 수정할 수 없습니다. 봇 메시지는 삭제만 가능합니다.",
      "role.user": "사용자",
      "role.assistant": "봇",
      "status.edited": "수정됨",
      "status.removed": "삭제됨",
      "toolCalls": "도구 호출 {count}개",
      "edit": "수정",
      "delete": "삭제",
      "save": "저장",
      "cancel": "취소",
      "retry": "다시 시도",
      "confirm.delete": "이 메시지를 모델 컨텍스트에서 삭제할까요? 화면의 원래 기록은 남습니다.",
      "error.session-not-found": "세션을 찾을 수 없습니다.",
      "error.session-busy": "세션이 실행 중이라 지금은 바꿀 수 없습니다.",
      "error.target-not-found": "대상 메시지를 찾을 수 없습니다. 새로고침하세요.",
      "error.not-editable": "이 메시지는 수정할 수 없습니다.",
      "error.not-deletable": "이 메시지는 삭제할 수 없습니다.",
      "error.stale": "메시지가 그 사이에 바뀌었습니다. 새로고침하세요.",
      "error.text-invalid": "메시지 내용이 비어 있습니다.",
      "error.text-too-large": "메시지가 너무 깁니다.",
      "error.internal": "호스트에서 처리하지 못했습니다.",
      "error.bad-request": "요청이 올바르지 않습니다.",
      "error.unauthorized": "인증이 필요합니다. 페이지를 새로고침하세요.",
      "error.unavailable": "세션 트윅 API를 찾을 수 없습니다. 플러그인과 DSH 버전을 확인하세요.",
      "error.network": "서버에 연결하지 못했습니다.",
      "error.timeout": "요청 시간이 초과되었습니다.",
      "error.bad-response": "서버 응답을 읽지 못했습니다.",
      "error.http": "서버가 요청을 거부했습니다."
    };
    const en = {
      "open": "Session tweak",
      "title": "Session tweak",
      "hint": "Changes the conversation the model sees from the next request on. The on-screen transcript stays untouched.",
      "close": "Close",
      "refresh": "Refresh",
      "loading": "Loading…",
      "empty": "No messages to show.",
      "busy": "This session is running. Edit or delete after it finishes.",
      "assistantEditUnsupported": "This runtime cannot edit assistant message bodies. Assistant messages can only be deleted.",
      "role.user": "User",
      "role.assistant": "Assistant",
      "status.edited": "Edited",
      "status.removed": "Removed",
      "toolCalls": "{count} tool calls",
      "edit": "Edit",
      "delete": "Delete",
      "save": "Save",
      "cancel": "Cancel",
      "retry": "Retry",
      "confirm.delete": "Remove this message from the model context? The on-screen transcript stays untouched.",
      "error.session-not-found": "Session not found.",
      "error.session-busy": "The session is running and cannot be changed right now.",
      "error.target-not-found": "Target message not found. Refresh and try again.",
      "error.not-editable": "This message cannot be edited.",
      "error.not-deletable": "This message cannot be deleted.",
      "error.stale": "The message changed in the meantime. Refresh and try again.",
      "error.text-invalid": "The message text is empty.",
      "error.text-too-large": "The message text is too large.",
      "error.internal": "The host could not process the request.",
      "error.bad-request": "The request is invalid.",
      "error.unauthorized": "Authentication required. Refresh the page.",
      "error.unavailable": "The session tweak API is unavailable. Check the plugin and DSH version.",
      "error.network": "Could not reach the server.",
      "error.timeout": "The request timed out.",
      "error.bad-response": "Could not read the server response.",
      "error.http": "The server refused the request."
    };
    const css = [
      ".st_trigger{border-radius:var(--dsw-radius-sm);min-height:28px;color:var(--dsw-alias-label-tertiary);background:transparent;border:0;align-items:center;gap:4px;padding:3px 4px;display:inline-flex;cursor:pointer}",
      "@media (hover:hover){.st_trigger:hover{color:var(--dsw-alias-label-secondary)}}",
      ".st_dialog{width:min(720px,calc(100vw - 32px))}",
      ".st_panel{display:flex;flex-direction:column;gap:10px;min-height:0;max-height:min(62vh,560px)}",
      ".st_status{margin:0;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}",
      ".st_banner{margin:0;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);padding:8px 10px;font-size:12px;line-height:17px}",
      ".st_note{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:17px}",
      ".st_noteError{margin:0;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:17px}",
      ".st_loadError{margin:0;border:0.5px solid var(--dsw-alias-state-error-primary);border-radius:var(--dsw-radius-md);padding:10px 12px;display:flex;flex-direction:column;gap:8px;align-items:flex-start}",
      ".st_errorText{margin:0;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:17px}",
      ".st_list{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:10px;min-height:0;overflow:auto}",
      ".st_row{border:0.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);padding:10px 12px;display:flex;flex-direction:column;gap:8px}",
      ".st_rowRemoved{opacity:0.62}",
      ".st_rowHead{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
      ".st_role{color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:600;line-height:17px}",
      ".st_badge{border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary);padding:0 7px;font-size:11px;line-height:16px}",
      ".st_meta{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}",
      ".st_text{margin:0;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:1.55;white-space:pre-wrap;overflow-wrap:anywhere}",
      ".st_editor{display:flex;flex-direction:column;gap:8px}",
      ".st_textarea{box-sizing:border-box;width:100%;min-height:84px;resize:vertical;border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);padding:8px 10px;font:inherit;font-size:13px;line-height:1.55}",
      ".st_textarea:focus-visible{outline:none;border-color:var(--dsw-alias-border-l3)}",
      ".st_editorActions,.st_actions{display:flex;gap:8px;justify-content:flex-end}",
      ".st_danger{color:var(--dsw-alias-state-error-primary)}"
    ].join("\n");
    if (typeof document !== "undefined" && document.querySelector('style[data-plugin-css="' + CSS_ID + '"]') === null) {
      const tag = document.createElement("style");
      tag.dataset.plugin = "dsh-session-tweak";
      tag.dataset.pluginCss = CSS_ID;
      tag.textContent = css;
      document.head.appendChild(tag);
    }
    class TweakApiError extends Error {
      constructor(code, message) {
        super(message === "" ? code : message);
        this.name = "TweakApiError";
        this.code = code;
      }
    }
    function utf8Bytes(value) {
      if (typeof TextEncoder === "function") return new TextEncoder().encode(value).length;
      let bytes = 0;
      for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if (code < 128) bytes += 1;
        else if (code < 2048) bytes += 2;
        else if (code >= 55296 && code <= 56319) {
          bytes += 4;
          index += 1;
        } else bytes += 3;
      }
      return bytes;
    }
    function describeError(t, error) {
      const code = error !== null && typeof error === "object" && typeof error.code === "string" ? error.code : "internal";
      const message = error !== null && typeof error === "object" && typeof error.message === "string" ? error.message : "";
      if (KNOWN_ERROR_CODES.indexOf(code) !== -1) {
        const key = "error." + code;
        const translated = t(key);
        if (translated !== key) return translated;
      }
      return message !== "" ? message : t("error.internal");
    }
    async function requestJSON(path, init) {
      const useAbort = typeof AbortController === "function";
      const controller = useAbort ? new AbortController() : null;
      const timer = useAbort ? setTimeout(() => controller.abort(), TIMEOUT_MS) : undefined;
      let response;
      try {
        const options = Object.assign({ cache: "no-store", credentials: "same-origin" }, init);
        if (controller !== null) options.signal = controller.signal;
        response = await fetch(path, options);
      } catch (error) {
        const aborted = controller !== null && controller.signal.aborted === true;
        throw new TweakApiError(aborted ? "timeout" : "network", error !== null && typeof error === "object" && typeof error.message === "string" ? error.message : "");
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
      if (response.status === 401 || response.status === 403) throw new TweakApiError("unauthorized", "HTTP " + response.status);
      if (response.status === 404) throw new TweakApiError("unavailable", "HTTP 404");
      let text = "";
      try {
        text = await response.text();
      } catch (error) {
        throw new TweakApiError("bad-response", "");
      }
      let body = null;
      if (text !== "") {
        try {
          body = JSON.parse(text);
        } catch (error) {
          body = null;
        }
      }
      if (!response.ok) {
        if (body !== null && typeof body === "object" && body.ok === false && body.error !== null && typeof body.error === "object" && typeof body.error.code === "string") throw new TweakApiError(body.error.code, typeof body.error.message === "string" ? body.error.message : "");
        throw new TweakApiError("http", "HTTP " + response.status);
      }
      if (body === null || typeof body !== "object") throw new TweakApiError("bad-response", "");
      if (body.ok !== true) {
        const error = body.error !== null && typeof body.error === "object" ? body.error : {};
        throw new TweakApiError(typeof error.code === "string" ? error.code : "internal", typeof error.message === "string" ? error.message : "");
      }
      return body;
    }
    function fetchState(sessionId) {
      return requestJSON(ENDPOINT + "/state?session=" + encodeURIComponent(sessionId), { method: "GET" }).then((body) => body.state);
    }
    function postJSON(path, payload) {
      return requestJSON(ENDPOINT + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      });
    }
    function HeaderAction({ sessionId, t }) {
      const [open, setOpen] = React.useState(false);
      const onClose = () => setOpen(false);
      return h(React.Fragment, null,
        h(Tooltip, { label: t("open"), side: "bottom" },
          h("button", {
            type: "button",
            className: "st_trigger",
            "aria-label": t("open"),
            onClick: () => setOpen(true)
          }, h(IconEditOutlineRegular, { size: 14 }))),
        open && typeof sessionId === "string" && sessionId !== "" ? h(TweakDialog, { sessionId, t, onClose }) : null);
    }
    function TweakDialog({ sessionId, t, onClose }) {
      const [status, setStatus] = React.useState("loading");
      const [state, setState] = React.useState(null);
      const [loadError, setLoadError] = React.useState(null);
      const [actionError, setActionError] = React.useState(null);
      const [edit, setEdit] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [revision, setRevision] = React.useState(0);
      const stateRef = React.useRef(null);
      React.useEffect(() => {
        let live = true;
        if (stateRef.current === null) setStatus("loading");
        setLoadError(null);
        fetchState(sessionId).then((next) => {
          if (!live) return;
          if (next === null || typeof next !== "object" || !Array.isArray(next.messages)) throw new TweakApiError("bad-response", "");
          stateRef.current = next;
          setState(next);
          setStatus("ready");
        }).catch((error) => {
          if (!live) return;
          if (stateRef.current === null) {
            setLoadError(error);
            setStatus("error");
          } else setActionError(error);
        });
        return () => {
          live = false;
        };
      }, [sessionId, revision]);
      const refresh = () => {
        setActionError(null);
        setRevision((value) => value + 1);
      };
      const runMutation = async (operation) => {
        setBusy(true);
        setActionError(null);
        try {
          await operation();
          setEdit(null);
          setRevision((value) => value + 1);
        } catch (error) {
          setActionError(error);
          if (error !== null && typeof error === "object" && (error.code === "stale" || error.code === "target-not-found")) setRevision((value) => value + 1);
        } finally {
          setBusy(false);
        }
      };
      const saveEdit = (row, text) => {
        void runMutation(() => postJSON("/edit", {
          sessionId,
          messageId: row.messageId,
          seq: row.seq,
          expectedText: row.text,
          text
        }));
      };
      const deleteRow = (row) => {
        const confirmed = typeof globalThis.confirm === "function" ? globalThis.confirm(t("confirm.delete")) === true : true;
        if (!confirmed) return;
        void runMutation(() => postJSON("/delete", {
          sessionId,
          messageId: row.messageId,
          seq: row.seq
        }));
      };
      const running = state !== null && state.running === true;
      const capabilities = state !== null && state.capabilities !== null && typeof state.capabilities === "object" ? state.capabilities : {};
      const assistantEdit = capabilities.editAssistant === true;
      const messages = state !== null && Array.isArray(state.messages) ? state.messages : [];
      const disabled = busy || running;
      const renderRow = (row) => {
        if (row === null || typeof row !== "object") return null;
        const removed = row.status === "removed";
        const editing = !removed && edit !== null && edit.id === row.messageId;
        const canEdit = !removed && row.editable === true && (row.role !== "assistant" || assistantEdit);
        const canDelete = !removed && row.deletable === true;
        const toolCallCount = typeof row.toolCallCount === "number" && row.toolCallCount > 0 ? row.toolCallCount : 0;
        const text = typeof row.text === "string" ? row.text : "";
        return h("li", {
          key: String(row.messageId),
          className: "st_row" + (removed ? " st_rowRemoved" : ""),
          "data-role": row.role === "assistant" ? "assistant" : "user",
          "data-status": typeof row.status === "string" ? row.status : "active"
        },
          h("div", { className: "st_rowHead" },
            h("span", { className: "st_role" }, t(row.role === "assistant" ? "role.assistant" : "role.user")),
            row.status === "edited" || removed ? h("span", { className: "st_badge" }, t("status." + (removed ? "removed" : "edited"))) : null,
            toolCallCount > 0 ? h("span", { className: "st_meta" }, t("toolCalls", { count: toolCallCount })) : null),
          editing
            ? h("div", { className: "st_editor" },
              h("textarea", {
                className: "st_textarea",
                value: edit.text,
                rows: 4,
                autoFocus: true,
                disabled,
                "aria-label": t("edit"),
                onChange: (event) => setEdit({ id: row.messageId, text: event.target.value })
              }),
              utf8Bytes(edit.text) > MAX_TEXT_BYTES ? h("p", { className: "st_noteError" }, t("error.text-too-large")) : null,
              h("div", { className: "st_editorActions" },
                h(Button, {
                  variant: "primary",
                  size: "sm",
                  disabled: disabled || edit.text.trim() === "" || utf8Bytes(edit.text) > MAX_TEXT_BYTES,
                  onClick: () => saveEdit(row, edit.text)
                }, t("save")),
                h(Button, { variant: "outline", size: "sm", disabled, onClick: () => setEdit(null) }, t("cancel"))))
            : h("p", { className: "st_text" }, text),
          !editing && (canEdit || canDelete)
            ? h("div", { className: "st_actions" },
              canEdit ? h(Button, { variant: "ghost", size: "sm", disabled, onClick: () => setEdit({ id: row.messageId, text }) }, t("edit")) : null,
              canDelete ? h(Button, { variant: "ghost", size: "sm", className: "st_danger", disabled, onClick: () => deleteRow(row) }, t("delete")) : null)
            : null);
      };
      const renderBody = () => {
        if (status === "loading") return h("p", { className: "st_status", role: "status" }, t("loading"));
        if (status === "error") {
          return h("div", { className: "st_loadError", role: "alert" },
            h("p", { className: "st_errorText" }, describeError(t, loadError)),
            h(Button, { variant: "outline", size: "sm", onClick: refresh }, t("retry")));
        }
        return h("div", { className: "st_panel" },
          running ? h("p", { className: "st_banner", role: "status" }, t("busy")) : null,
          actionError !== null ? h("p", { className: "st_errorText", role: "alert" }, describeError(t, actionError)) : null,
          assistantEdit ? null : h("p", { className: "st_note" }, t("assistantEditUnsupported")),
          messages.length === 0
            ? h("p", { className: "st_status" }, t("empty"))
            : h("ul", { className: "st_list" }, messages.map(renderRow)));
      };
      return h(Modal, {
        open: true,
        onClose,
        closeLabel: t("close"),
        title: t("title"),
        description: t("hint"),
        className: "st_dialog",
        onKeyDownCapture: (event) => {
          if (event.key === "Escape" && edit !== null) {
            event.preventDefault();
            event.stopPropagation();
            setEdit(null);
          }
        },
        footer: h(React.Fragment, null,
          h(Button, {
            variant: "outline",
            size: "sm",
            icon: h(IconRefreshOutlineRegular, { size: 14 }),
            disabled: busy || status === "loading",
            onClick: refresh
          }, t("refresh")),
          h(Button, { variant: "primary", size: "sm", onClick: onClose }, t("close")))
      }, renderBody());
    }
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { ko, en }), "session-tweak: dictionaries");
      ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
        name: "conversation.session.header.actions",
        id: "session-tweak",
        order: 30,
        locale: NS
      }, HeaderAction));
    }
    return { name: "session-tweak", inject: ["slots", "locale"], apply };
  }
});
