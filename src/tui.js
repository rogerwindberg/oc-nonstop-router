import { effect as _$effect } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { createTextNode as _$createTextNode } from "@opentui/solid";
import { insertNode as _$insertNode } from "@opentui/solid";
import { memo as _$memo } from "@opentui/solid";
import { setProp as _$setProp } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
import { createComponent as _$createComponent } from "@opentui/solid";
/** @jsxImportSource @opentui/solid */
import { createSignal, For, Show } from "solid-js";
import { createStore } from "./store.js";
import { createController, formatError, getFooterSummaryData, parseCommand } from "./control.js";
import { readUsage, releaseIfRecovered } from "./usage.js";
import { authorizeBrowser, authorizeDevice } from "./oauth.js";
const tui = async api => {
  const store = createStore();
  const controller = createController(store);
  const [enabled, setEnabled] = createSignal(await store.isEnabled());
  const [isLimited, setIsLimited] = createSignal(false);
  const [summaryData, setSummaryData] = createSignal(null);
  let disposed = false;
  let refreshing = false;
  const toast = (message, variant = "info") => api.ui.toast({
    title: "Nonstop Router",
    message,
    variant
  });
  const report = error => toast(formatError(error), "error");
  async function refreshIndicator(withUsage = false) {
    const state = await store.isEnabled();
    setEnabled(state);
    if (!state) {
      setIsLimited(false);
      setSummaryData(null);
      return;
    }
    const accounts = await store.list();
    const active = accounts.filter(item => item.inRotation !== false && !item.invalid);
    const allLimited = active.length > 0 && active.every(item => (item.limitedUntil ?? 0) > Date.now());
    if (allLimited) {
      setIsLimited(true);
      setSummaryData(null);
      if (!withUsage || refreshing) return;
      refreshing = true;
      try {
        await Promise.all(active.map(async account => {
          const usage = await readUsage(store, account.id);
          await releaseIfRecovered(store, account, usage);
        }));
        const refreshed = await store.list();
        const recoveredAccount = refreshed.find(item => item.inRotation !== false && !item.invalid && (item.limitedUntil ?? 0) <= Date.now());
        if (recoveredAccount && !disposed) {
          setIsLimited(false);
          const result = await readUsage(store, recoveredAccount.id);
          setSummaryData(getFooterSummaryData(recoveredAccount, result));
        }
      } finally {
        refreshing = false;
      }
      return;
    }
    setIsLimited(false);
    const account = active.find(item => (item.limitedUntil ?? 0) <= Date.now());
    if (!account) {
      setSummaryData(null);
      return;
    }
    if (!withUsage || refreshing) return;
    refreshing = true;
    try {
      const result = await readUsage(store, account.id);
      if (!disposed) setSummaryData(getFooterSummaryData(account, result));
    } finally {
      refreshing = false;
    }
  }
  function alert(title, message) {
    const DialogAlert = api.ui.DialogAlert;
    api.ui.dialog.replace(() => _$createComponent(DialogAlert, {
      title: title,
      message: message
    }));
  }
  async function showStatus() {
    let closed = false;
    const DialogAlert = api.ui.DialogAlert;
    api.ui.dialog.replace(() => _$createComponent(DialogAlert, {
      title: "Nonstop Router status",
      message: "Loading account usage\u2026"
    }), () => {
      closed = true;
    });
    const text = await controller.status();
    if (closed || disposed) return;
    const [state, ...accounts] = text.split("\n\n");
    if (accounts.length === 1 && accounts[0] === "No OpenAI OAuth accounts configured.") {
      alert("Nonstop Router status", text);
    } else {
      showSelect(state, accounts.map((account, index) => {
        const [title, ...details] = account.split("\n");
        return {
          title,
          value: String(index),
          description: details.join(" · ")
        };
      }), value => {
        const [title, ...details] = accounts[Number(value)].split("\n");
        showSelect(title, details.map((line, index) => ({
          title: line,
          value: String(index)
        })), () => {});
      });
    }
    void refreshIndicator(true).catch(report);
  }
  function showSelect(title, options, onSelect) {
    const DialogSelect = api.ui.DialogSelect;
    api.ui.dialog.replace(() => _$createComponent(DialogSelect, {
      title: title,
      options: options,
      onSelect: item => void onSelect(item.value)
    }));
  }
  function promptName(title, value, onConfirm) {
    const DialogPrompt = api.ui.DialogPrompt;
    api.ui.dialog.replace(() => _$createComponent(DialogPrompt, {
      title: title,
      value: value,
      placeholder: "Account name",
      onConfirm: name => void onConfirm(name)
    }));
  }
  async function accountMenu(id) {
    const account = (await store.list()).find(item => item.id === id);
    if (!account) return showConfig();
    const options = [{
      title: "Rename account",
      value: "rename"
    }, {
      title: "Move earlier in sequence",
      value: "up"
    }, {
      title: "Move later in sequence",
      value: "down"
    }, account.inRotation === false ? {
      title: "Add to sequence",
      value: "add"
    } : {
      title: "Remove from sequence",
      value: "remove"
    }, {
      title: "Back",
      value: "back"
    }];
    showSelect(account.name, options, async action => {
      try {
        if (action === "rename") {
          promptName("Rename account", account.name, async name => {
            try {
              await store.rename(id, name);
              await showConfig();
            } catch (error) {
              report(error);
            }
          });
          return;
        }
        if (action === "up" || action === "down") await store.move(id, action === "up" ? -1 : 1);
        if (action === "remove" || action === "add") await store.setInRotation(id, action === "add");
        await showConfig();
      } catch (error) {
        report(error);
      }
    });
  }
  async function signIn(method, name) {
    const abort = new AbortController();
    try {
      const flow = await (method === "browser" ? authorizeBrowser({
        signal: abort.signal
      }) : authorizeDevice({
        signal: abort.signal
      }));
      let closed = false;
      const DialogAlert = api.ui.DialogAlert;
      api.ui.dialog.replace(() => _$createComponent(DialogAlert, {
        title: "Sign in to OpenAI",
        get message() {
          return `${flow.url}\n\n${flow.instructions}\n\nWaiting for authorization…`;
        }
      }), () => {
        closed = true;
        abort.abort();
      });
      const result = await flow.callback();
      if (closed || disposed) return;
      if (result?.type !== "success" || !result.access || !result.refresh) throw new Error("Authorization failed");
      const {
        type: _type,
        ...credentials
      } = result;
      const auth = {
        type: "oauth",
        ...credentials
      };
      const id = await store.upsert(auth, name.trim() || undefined);
      await store.setInRotation(id, true);
      const native = await controller.nativeAuth();
      if (native?.type !== "oauth") {
        const response = await api.client.auth.set({
          providerID: "openai",
          auth
        });
        if (response.error) throw new Error("Could not activate OpenAI in OpenCode");
        toast("Account added. Restart OpenCode if the provider is not yet available.", "success");
      }
      if (!closed && !disposed) {
        toast("Account added", "success");
        await showConfig();
      }
    } catch (error) {
      if (!disposed && !abort.signal.aborted) report(error);
    }
  }
  async function showConfig() {
    const accounts = await store.list();
    const options = [{
      title: "Add signed-in OpenCode account",
      value: "native",
      description: "Use the current OpenAI OAuth login"
    }, {
      title: "Sign in with browser",
      value: "browser"
    }, {
      title: "Sign in with device code",
      value: "device"
    }, ...accounts.map((account, index) => ({
      title: `${index + 1}. ${account.name}`,
      description: account.inRotation === false ? "Not in sequence" : account.invalid ? "Login required" : "In sequence",
      value: `account:${account.id}`
    }))];
    showSelect("Nonstop Router configuration", options, async value => {
      if (value.startsWith("account:")) return accountMenu(value.slice(8));
      if (value === "native") {
        try {
          await controller.addNative();
          toast("Account added to sequence", "success");
          await showConfig();
        } catch (error) {
          report(error);
        }
        return;
      }
      promptName("Name this account", "", name => signIn(value, name));
    });
  }
  async function run(command) {
    try {
      if (command === "config") return await showConfig();
      if (command === "status") return await showStatus();
      await controller.setEnabled(command === "enable");
      await refreshIndicator();
      toast(`Nonstop Router: ${command === "enable" ? "ON" : "OFF"}`, "success");
    } catch (error) {
      report(error);
    }
  }
  api.keymap.registerLayer({
    commands: [{
      name: "nonstop.config",
      title: "Nonstop Router: Configure",
      category: "Nonstop Router",
      namespace: "palette",
      slashName: "nonstop",
      run: () => void run("config")
    }, ...["enable", "disable", "status"].map(name => ({
      name: `nonstop.${name}`,
      title: `Nonstop Router: ${name}`,
      category: "Nonstop Router",
      namespace: "palette",
      slashName: `nonstop-${name}`,
      run: () => void run(name)
    }))]
  });
  api.keymap.intercept("key", ctx => {
    if (api.mode.current() !== "base" || api.ui.dialog.open || !["return", "enter"].includes(ctx.event.name) || ctx.event.shift || ctx.event.ctrl || ctx.event.meta) return;
    const editor = api.renderer.currentFocusedEditor;
    if (!editor || typeof editor.plainText !== "string") return;
    const command = parseCommand(editor.plainText);
    if (!command) return;
    ctx.consume();
    editor.clear();
    void run(command);
  }, {
    priority: 1000
  });
  api.slots.register({
    slots: {
      app_bottom() {
        return (() => {
          var _el$ = _$createElement("box"),
            _el$2 = _$createElement("text"),
            _el$3 = _$createTextNode(`Nonstop Router: `);
          _$insertNode(_el$, _el$2);
          _$setProp(_el$, "flexDirection", "row");
          _$setProp(_el$, "gap", 2);
          _$setProp(_el$, "paddingLeft", 1);
          _$insertNode(_el$2, _el$3);
          _$insert(_el$2, () => enabled() ? "ON" : "OFF", null);
          _$insert(_el$, _$createComponent(Show, {
            get when() {
              return isLimited();
            },
            get children() {
              var _el$4 = _$createElement("text");
              _$insertNode(_el$4, _$createTextNode(`Usage limit reached. Waiting a while...`));
              _$setProp(_el$4, "wrapMode", "none");
              _$setProp(_el$4, "truncate", true);
              _$effect(_$p => _$setProp(_el$4, "fg", api.theme.current.error, _$p));
              return _el$4;
            }
          }), null);
          _$insert(_el$, _$createComponent(Show, {
            get when() {
              return _$memo(() => !!!isLimited())() && summaryData();
            },
            children: data => (() => {
              var _el$6 = _$createElement("text"),
                _el$7 = _$createTextNode(`Usage for `),
                _el$8 = _$createTextNode(`: `);
              _$insertNode(_el$6, _el$7);
              _$insertNode(_el$6, _el$8);
              _$setProp(_el$6, "wrapMode", "none");
              _$setProp(_el$6, "truncate", true);
              _$insert(_el$6, () => data().accountName, _el$8);
              _$insert(_el$6, _$createComponent(For, {
                get each() {
                  return data().items;
                },
                children: item => [_$memo(() => item.label), (() => {
                  var _el$0 = _$createElement("span");
                  _$insert(_el$0, () => item.usedText);
                  _$effect(_$p => _$setProp(_el$0, "style", {
                    fg: item.used > 80 ? api.theme.current.error : api.theme.current.textMuted
                  }, _$p));
                  return _el$0;
                })(), _$memo(() => item.resetText), " · "]
              }), null);
              _$insert(_el$6, () => data().resetsText, null);
              _$insert(_el$6, (() => {
                var _c$ = _$memo(() => !!data().lastCheckText);
                return () => _c$() ? ` · ${data().lastCheckText}` : "";
              })(), null);
              _$effect(_$p => _$setProp(_el$6, "fg", api.theme.current.textMuted, _$p));
              return _el$6;
            })()
          }), null);
          _$effect(_$p => _$setProp(_el$2, "fg", enabled() ? api.theme.current.success : api.theme.current.error, _$p));
          return _el$;
        })();
      }
    }
  });
  const stateTimer = setInterval(() => void refreshIndicator().catch(report), 2000);
  const usageTimer = setInterval(() => void refreshIndicator(true).catch(report), 300_000);
  api.lifecycle.onDispose(() => {
    disposed = true;
    clearInterval(stateTimer);
    clearInterval(usageTimer);
  });
  void refreshIndicator(true).catch(report);
};
export default {
  id: "oc-nonstop-router",
  tui
};
