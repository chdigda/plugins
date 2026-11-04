window.__ModuleLoader__.load({
  id: "dsh-web-search",
  factory(require) {
    const { jsx, jsxs } = require("react/jsx-runtime");
    const { SettingsForm, SettingsSecretField, SettingsFormModel, settingsTextField } =
      require("@deepseek-ai/dsh-client-ui-primitives");
    const { createSnapshotStore } = require("@deepseek-ai/dsh-client-store");

    const SETTINGS_NS = "web-search";
    const NS = "settings.dshWebSearch";
    const PROVIDERS = ["tavily-brave", "brave-tavily", "tavily", "brave"];
    const SWITCHES = ["tavilyEnabled", "braveEnabled"];
    const KEYS = [
      { field: "tavilyApiKey", refField: "tavilyApiKeyEnv", defaultRef: "TAVILY_API_KEY", label: "tavilyKey" },
      { field: "braveApiKey", refField: "braveApiKeyEnv", defaultRef: "BRAVE_SEARCH_API_KEY", label: "braveKey" },
    ];
    const en = {
      title: "Web Search",
      tavilyEnabled: "Use Tavily",
      braveEnabled: "Use Brave",
      providerHint: "Disabled providers are never called, including fallback requests.",
      removeKey: "Delete stored key",
      description: "Use Tavily first, with Brave as the fallback. Web fetch stays HTTP.",
      tavilyKey: "Tavily API key",
      braveKey: "Brave Search API key",
      keyHint: "Stored securely through credentials, never in the settings file. Enter a new key to replace it; leave blank to keep it. Delete removes the stored key, not an environment variable.",
      keySet: "Key configured",
      keyUnset: "No key configured",
      keyLoading: "Checking key status…",
      keyUnknown: "Key status unavailable",
      credentialReadOnly: "This credential is read-only.",
      retry: "Retry key status",
      referencesChanged: "A credential reference changed. Re-enter any unsaved key before saving.",
      searchProvider: "Default search provider",
      router: "Tavily → Brave (fallback)",
      reverseRouter: "Brave → Tavily (fallback)",
      tavily: "Tavily only",
      brave: "Brave only",
      otherProvider: "Another provider (unchanged)",
      selectionHint: "Choose which provider to try first. Fallback uses only enabled providers. This setting changes search only; HTTP fetch is unchanged.",
      selectionUnavailable: "The web provider settings are unavailable; keys can still be configured.",
      unavailable: "This plugin is not loaded, so it cannot be configured right now.",
      readOnly: "This deployment stores these settings read-only.",
      save: "Save",
      saving: "Saving…",
      saveFailed: "The deployment did not accept these changes. Unsaved values were kept for retry.",
    };
    const ko = {
      title: "웹 검색",
      tavilyEnabled: "Tavily 사용",
      braveEnabled: "Brave 사용",
      providerHint: "꺼진 공급자는 툴 호출과 대체 검색에서 제외됩니다.",
      removeKey: "저장된 키 삭제",
      description: "Tavily를 우선 사용하고 Brave로 대체합니다. 웹 페이지 가져오기는 HTTP를 유지합니다.",
      tavilyKey: "Tavily API 키",
      braveKey: "Brave Search API 키",
      keyHint: "설정 파일이 아닌 보안 자격 증명 저장소에 보관합니다. 새 키를 입력하면 교체하고 비워 두면 유지합니다. 삭제는 저장된 키에만 적용하며 환경변수는 유지합니다.",
      keySet: "키 설정됨",
      keyUnset: "키 없음",
      keyLoading: "키 상태 확인 중…",
      keyUnknown: "키 상태를 확인할 수 없습니다",
      credentialReadOnly: "이 자격 증명은 읽기 전용입니다.",
      retry: "키 상태 다시 확인",
      referencesChanged: "자격 증명 참조가 변경되었습니다. 저장하지 않은 키를 다시 입력해 주세요.",
      searchProvider: "기본 검색 공급자",
      router: "Tavily → Brave (대체 검색)",
      reverseRouter: "Brave → Tavily (대체 검색)",
      tavily: "Tavily만 사용",
      brave: "Brave만 사용",
      otherProvider: "다른 공급자 (변경 없음)",
      selectionHint: "먼저 시도할 공급자 순서를 선택합니다. 대체 검색도 켜진 공급자만 사용합니다. 검색 공급자만 변경하며 HTTP 페이지 가져오기는 유지합니다.",
      selectionUnavailable: "웹 공급자 설정을 사용할 수 없지만 API 키는 설정할 수 있습니다.",
      unavailable: "플러그인이 로드되지 않아 현재 설정할 수 없습니다.",
      readOnly: "이 배포의 설정은 읽기 전용입니다.",
      save: "저장",
      saving: "저장 중…",
      saveFailed: "변경 사항이 저장되지 않았습니다. 다시 시도할 수 있도록 입력을 유지했습니다.",
    };
    const zh = {
      title: "网页搜索",
      tavilyEnabled: "使用 Tavily",
      braveEnabled: "使用 Brave",
      providerHint: "关闭的提供方不会被调用，也不会用于回退搜索。",
      removeKey: "删除已存密钥",
      description: "优先使用 Tavily，失败时回退到 Brave。网页抓取保持 HTTP。",
      tavilyKey: "Tavily API Key",
      braveKey: "Brave Search API Key",
      keyHint: "密钥通过凭据服务安全保存，不写入设置文件。输入新密钥可替换，留空保留。删除仅清除存储的密钥，不清除环境变量。",
      keySet: "已配置密钥",
      keyUnset: "未配置密钥",
      keyLoading: "正在检查密钥状态…",
      keyUnknown: "无法获取密钥状态",
      credentialReadOnly: "此凭据为只读。",
      retry: "重新检查密钥状态",
      referencesChanged: "凭据引用已更改。请重新输入尚未保存的密钥。",
      searchProvider: "默认搜索提供方",
      router: "Tavily → Brave（回退）",
      reverseRouter: "Brave → Tavily（回退）",
      tavily: "仅 Tavily",
      brave: "仅 Brave",
      otherProvider: "其他提供方（保持不变）",
      selectionHint: "可选择提供方的尝试顺序；仅使用已启用的提供方进行回退。仅更改搜索提供方；HTTP 抓取保持不变。",
      selectionUnavailable: "网页提供方设置暂不可用，仍可配置密钥。",
      unavailable: "插件未加载，暂时无法配置。",
      readOnly: "此部署的设置为只读。",
      save: "保存",
      saving: "保存中…",
      saveFailed: "未能保存更改；已保留未保存的输入供重试。",
    };

    class WebSearchCardController {
      constructor(scopes, ctx) {
        this.scopes = scopes;
        this.ctx = ctx;
        this.disposed = false;
        this.saving = false;
        this.keyRemovalFailed = false;
        this.referencesChanged = false;
        this.draftRefs = new Map();
        this.readVersions = new Map();
        this.credentials = Object.fromEntries(KEYS.map(({ field }) => [field, {
          ref: this.ref(field), configured: null, writable: false, loading: false, error: false,
        }]));
        this.keys = new SettingsFormModel(scopes.provider, SWITCHES.map(field => ({
          field,
          format: value => String(value !== false),
          parse: text => ({ kind: "set", value: text === "true" }),
        })), KEYS.map(({ field }) => ({
          field,
          write: (value) => this.writeKey(field, value),
        })));
        this.selection = new SettingsFormModel(scopes.web, [{
          ...settingsTextField("searchProvider"),
          parse: (text) => PROVIDERS.includes(text) ? { kind: "set", value: text } : undefined,
        }]);
        this.store = createSnapshotStore(this.projection());
        this.unsubscribe = [
          this.keys.bind(() => this.keys.shell()).subscribe(() => this.publish()),
          this.selection.bind(() => this.selection.shell()).subscribe(() => this.publish()),
          scopes.provider.subscribe(() => this.syncReferences()),
        ];
        this.syncReferences();
      }

      ref(field) {
        const key = KEYS.find((item) => item.field === field);
        const declared = this.scopes.provider.getSnapshot().value?.[key.refField];
        return typeof declared === "string" && declared.trim() ? declared.trim() : key.defaultRef;
      }

      projection() {
        const keys = this.keys.shell();
        const selection = this.selection.shell();
        const dirty = keys.dirty || selection.dirty;
        const writable = keys.writable && (!selection.dirty || selection.writable);
        const saving = this.saving || keys.saving || selection.saving;
        const keyFields = Object.fromEntries(KEYS.map(({ field }) => {
          const info = this.credentials[field];
          return [field, {
            text: this.keys.field(field).text,
            configured: info.configured,
            loading: info.loading,
            error: info.error,
            writable: keys.available && keys.writable && info.writable && !info.loading && !info.error && !saving,
            readOnly: !info.loading && !info.error && info.configured !== null && !info.writable,
          }];
        }));
        const blockedKey = KEYS.some(({ field }) => this.keys.field(field).text.trim() !== "" &&
          (!this.credentials[field].writable || this.credentials[field].loading || this.credentials[field].error));
        return {
          available: keys.available,
          writable,
          dirty,
          invalid: keys.invalid || selection.invalid || (dirty && !writable) || blockedKey,
          saving,
          failed: keys.failed || selection.failed || this.keyRemovalFailed,
          providers: Object.fromEntries(SWITCHES.map(field => [field, this.keys.field(field).text === "true"])),
          providersWritable: keys.available && keys.writable && !saving,
          keyFields,
          referencesChanged: this.referencesChanged,
          selectionAvailable: selection.available,
          selectionWritable: selection.available && selection.writable && !saving,
          searchProvider: this.selection.field("searchProvider").text,
        };
      }

      publish() {
        if (!this.disposed) this.store.set(this.projection());
      }

      syncReferences() {
        if (this.disposed) return;
        if (this.scopes.provider.getSnapshot().status !== "ready") {
          this.discard();
          for (const { field } of KEYS) {
            this.readVersions.set(field, (this.readVersions.get(field) ?? 0) + 1);
            this.credentials[field] = { ref: this.ref(field), configured: null, writable: false, loading: false, error: false };
          }
          this.publish();
          return;
        }
        const changed = [];
        for (const { field } of KEYS) {
          if (this.credentials[field].ref !== this.ref(field)) {
            if (this.keys.field(field).text.trim()) this.referencesChanged = true;
            this.keys.actions().edit(field, "");
            this.draftRefs.delete(field);
            changed.push(field);
          } else if (this.credentials[field].configured === null && !this.credentials[field].loading && !this.credentials[field].error) {
            changed.push(field);
          }
        }
        if (changed.length) void this.readCredentials(changed);
        this.publish();
      }

      async readCredentials(fields = KEYS.map((key) => key.field)) {
        if (this.disposed || this.scopes.provider.getSnapshot().status !== "ready") return;
        const requests = fields.map((field) => {
          const version = (this.readVersions.get(field) ?? 0) + 1;
          this.readVersions.set(field, version);
          const ref = this.ref(field);
          const previous = this.credentials[field];
          this.credentials[field] = {
            ref, configured: previous.ref === ref ? previous.configured : null,
            writable: false, loading: true, error: false,
          };
          return { field, ref, version };
        });
        this.publish();
        let response;
        try {
          response = await this.ctx.remote.credentials.describe([...new Set(requests.map((item) => item.ref))]);
        } catch {
        }
        for (const { field, ref, version } of requests) {
          if (this.disposed || ref !== this.ref(field) || this.readVersions.get(field) !== version) continue;
          const info = response?.ok ? response.value?.[ref] : undefined;
          this.credentials[field] = {
            ref,
            configured: typeof info?.configured === "boolean" ? info.configured : null,
            writable: info?.writable === true,
            loading: false,
            error: typeof info?.configured !== "boolean",
          };
        }
        this.publish();
      }

      async writeKey(field, value) {
        const ref = this.ref(field);
        if (this.disposed || this.draftRefs.get(field) !== ref || !this.credentials[field].writable) return false;
        const response = await this.ctx.remote.credentials.set(ref, value);
        if (!response?.ok) return false;
        await this.readCredentials([field]);
        return !this.disposed && ref === this.ref(field);
      }

      editKey(field, text) {
        if (!KEYS.some((key) => key.field === field) || !this.projection().keyFields[field].writable) return;
        this.draftRefs.set(field, this.ref(field));
        this.referencesChanged = false;
        this.keyRemovalFailed = false;
        this.keys.actions().edit(field, text);
      }

      editEnabled(field, enabled) {
        if (SWITCHES.includes(field) && this.projection().providersWritable) this.keys.actions().edit(field, String(enabled));
      }

      async removeKey(field) {
        const key = this.projection().keyFields[field];
        if (!key?.writable || !key.configured) return;
        const ref = this.ref(field);
        this.saving = true;
        this.keyRemovalFailed = false;
        this.publish();
        try {
          const result = await this.ctx.remote.credentials.unset(ref);
          if (!result?.ok) throw new Error();
          if (ref === this.ref(field)) {
            this.keys.actions().edit(field, "");
            this.draftRefs.delete(field);
          }
          await this.readCredentials([field]);
        } catch {
          this.keyRemovalFailed = true;
        } finally {
          this.saving = false;
          this.publish();
        }
      }

      select(provider) {
        if (!PROVIDERS.includes(provider) || !this.projection().selectionWritable) return;
        const base = this.scopes.web.getSnapshot().base;
        const actions = this.selection.actions();
        if (base?.searchProvider === provider) actions.resetField("searchProvider");
        else actions.edit("searchProvider", provider);
      }

      async save() {
        const state = this.projection();
        if (this.disposed || !state.available || !state.writable || !state.dirty || state.invalid || state.saving) return;
        this.saving = true;
        this.publish();
        try {
          if (this.keys.shell().dirty) await this.keys.save();
          if (this.disposed || this.keys.shell().failed) return;
          if (!this.keys.shell().dirty) this.draftRefs.clear();
          if (this.selection.shell().dirty && this.selection.shell().available) await this.selection.save();
        } finally {
          this.saving = false;
          this.publish();
        }
      }

      discard() {
        this.keys.actions().discard();
        this.selection.actions().discard();
        this.draftRefs.clear();
        this.referencesChanged = false;
        this.keyRemovalFailed = false;
        this.publish();
      }

      inject() {
        return {
          hooks: { webSearchCard: this.store },
          editKey: (field, text) => this.editKey(field, text),
          select: (provider) => this.select(provider),
          editEnabled: (field, enabled) => this.editEnabled(field, enabled),
          removeKey: (field) => this.removeKey(field),
          retry: () => this.readCredentials(),
          save: () => this.save(),
          discard: () => this.discard(),
        };
      }

      dispose() {
        this.discard();
        this.disposed = true;
        for (const off of this.unsubscribe) off();
        this.keys.dispose();
        this.selection.dispose();
      }
    }

    function WebSearchCard(props) {
      const { t } = props;
      const state = props.useWebSearchCard((snapshot) => snapshot);
      const hasStatusError = KEYS.some(({ field }) => state.keyFields[field].error);
      return jsxs(SettingsForm, {
        labels: Object.fromEntries(["unavailable", "readOnly", "saveFailed", "save", "saving"].map((key) => [key, t(key)])),
        state,
        onSave: props.save,
        onDiscard: props.discard,
        children: [
          ...SWITCHES.map(field => jsxs("label", {
            className: "dsh-web-search-toggle",
            children: [
              jsx("input", { type: "checkbox", checked: state.providers[field], disabled: !state.providersWritable, onChange: event => props.editEnabled(field, event.target.checked) }),
              t(field),
            ],
          }, field)),
          jsx("p", { className: "dsh-web-search-hint", children: t("providerHint") }),
          ...KEYS.map(({ field, label }) => {
            const key = state.keyFields[field];
            return jsxs("div", { className: "dsh-web-search-field", children: [jsx(SettingsSecretField, {
              id: "plugin-config-web-search-" + field,
              label: t(label),
              hint: t("keyHint") + (key.readOnly ? " " + t("credentialReadOnly") : ""),
              text: key.text,
              disabled: !key.writable,
              configured: key.configured === true,
              stateLabel: t(key.loading ? "keyLoading" : key.error || key.configured === null ? "keyUnknown" : key.configured ? "keySet" : "keyUnset"),
              onEdit: (text) => props.editKey(field, text),
            }), jsx("button", {
              type: "button", className: "dsh-web-search-retry",
              disabled: !key.writable || !key.configured,
              "aria-label": t("removeKey") + ": " + t(label),
              onClick: () => props.removeKey(field), children: t("removeKey"),
            })] }, field);
          }),
          hasStatusError ? jsx("button", {
            type: "button", className: "dsh-web-search-retry", disabled: state.saving,
            onClick: props.retry, children: t("retry"),
          }) : null,
          state.referencesChanged ? jsx("p", {
            className: "dsh-web-search-hint", role: "status", children: t("referencesChanged"),
          }) : null,
          state.selectionAvailable ? jsxs("div", {
            className: "dsh-web-search-field",
            children: [
              jsx("label", { htmlFor: "plugin-config-web-search-search", children: t("searchProvider") }),
              jsxs("select", {
                id: "plugin-config-web-search-search",
                className: "dsh-web-search-select",
                value: state.searchProvider,
                disabled: !state.selectionWritable,
                "aria-describedby": "plugin-config-web-search-search-hint",
                onChange: (event) => props.select(event.target.value),
                children: [
                  !PROVIDERS.includes(state.searchProvider) ? jsx("option", {
                    value: state.searchProvider, disabled: true, children: t("otherProvider"),
                  }) : null,
                  ...PROVIDERS.map((provider, index) => jsx("option", {
                    value: provider, children: t(index === 0 ? "router" : index === 1 ? "reverseRouter" : provider),
                  }, provider)),
                ],
              }),
              jsx("p", { id: "plugin-config-web-search-search-hint", className: "dsh-web-search-hint", children: t("selectionHint") }),
            ],
          }) : jsx("p", { className: "dsh-web-search-hint", role: "status", children: t("selectionUnavailable") }),
        ],
      });
    }

    const inject = ["slots", "locale", "remote", "remote.credentials", "configForms"];
    function apply(ctx) {
      const t = ctx.locale.bind(NS);
      ctx.effect(() => ctx.locale.register(NS, { en, ko, zh }), "tavily-brave: dictionaries");
      ctx.effect(() => {
        const tag = document.createElement("style");
        tag.dataset.plugin = "dsh-web-search";
        tag.textContent = ".dsh-web-search-toggle{display:flex;align-items:center;gap:8px;font-size:13px}.dsh-web-search-field{display:grid;gap:6px;color:var(--dsw-alias-label-primary);font-size:13px}.dsh-web-search-hint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5}.dsh-web-search-select{box-sizing:border-box;width:100%;min-height:36px;padding:7px 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-settings-card-fill);color:var(--dsw-alias-label-primary);font:inherit}.dsh-web-search-select:focus-visible,.dsh-web-search-retry:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}.dsh-web-search-select:disabled,.dsh-web-search-retry:disabled{opacity:.5;cursor:default}.dsh-web-search-retry{justify-self:start;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);padding:6px 10px;font:inherit;font-size:12px;cursor:pointer}";
        document.head.appendChild(tag);
        return () => tag.remove();
      }, "tavily-brave: card styles");
      const card = new WebSearchCardController({
        provider: ctx.configForms.get(SETTINGS_NS),
        web: ctx.configForms.get("web"),
      }, ctx);
      ctx.effect(() => () => card.dispose(), "tavily-brave: form subscriptions");
      ctx.effect(() => ctx.remote.$on("credentials/reference-updated", (ref) => {
        const fields = KEYS.filter(({ field }) => card.ref(field) === ref).map(({ field }) => field);
        if (fields.length) void card.readCredentials(fields);
      }), "tavily-brave: credential invalidations");
      ctx.effect(() => ctx.on("connection/reset", () => {
        void card.readCredentials();
      }), "tavily-brave: credential reconnect");
      ctx.effect(() => ctx.configForms.whileServed([SETTINGS_NS], () => ctx.slots.inject("plugins.bundle.config", () => ctx.slots.register({
        name: "plugins.bundle.config",
        key: "dsh-web-search",
        locale: NS,
        inject: () => card.inject(),
      }, WebSearchCard))), "tavily-brave: plugins page");
    }

    return { apply, inject, NS, SETTINGS_NS, WebSearchCardController, WebSearchCard };
  },
});
