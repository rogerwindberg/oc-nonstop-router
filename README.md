# Nonstop Router

An **OpenCode 1** plugin that routes OpenAI/ChatGPT OAuth requests across multiple accounts. When an account reaches a rate limit, Nonstop Router tries another account. If all accounts are temporarily limited, it waits for the earliest reset and retries the request without requiring another message.

## Features

- Add and name multiple OpenAI OAuth accounts using browser or device authentication.
- Automatically switch accounts on HTTP 429 and wait for temporary limits to reset.
- Respect provider reset information, use increasing backoff when no reset is supplied, and allow users to cancel the wait.
- Refresh each account's token independently and coordinate storage across processes.
- Check account availability without printing credentials.

## Requirements

- OpenCode **1.19.3**, the version used by the integration tests. Other OpenCode 1 versions and OpenCode 2 have not been verified.
- Linux or Windows with **WSL**, with `flock` and `sh` available. Native Windows and macOS have not been tested.
- Node.js **20.3 or later** for the status command and tests. OpenCode installs npm plugins automatically into its cache.
- OpenAI/ChatGPT accounts with access to the OAuth flow and the models you intend to use. This plugin does not change provider limits or grant model access.

## Installation

Choose **one** of the options below. The examples show minimal configuration; merge them into your existing `opencode.json` or `opencode.jsonc` rather than replacing unrelated settings. Global configuration is stored in `~/.config/opencode/`; project configuration is stored in the project root. OpenCode merges configuration from both locations.

### Option 1: npm through OpenCode

Add the package to the `plugin` array. OpenCode installs it when it starts:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["oc-nonstop-router@1.0.1"],
  "provider": {
    "openai": {
      "options": {
        "headerTimeout": false,
        "timeout": false
      }
    }
  }
}
```

The example pins the package version. To use the latest resolved version, replace `"oc-nonstop-router@1.0.1"` with `"oc-nonstop-router"`.

`headerTimeout: false` allows the request to remain pending while the plugin waits for a reset; `timeout: false` disables the overall provider request timeout. The plugin still applies a five-minute timeout to each network attempt before response headers arrive.

### Option 2: clone from GitHub

```bash
git clone https://github.com/rogerwindberg/oc-nonstop-router.git ~/oc-nonstop-router
```

Point OpenCode at the entry file using an **absolute** `file://` URL. Replace `/home/your-user` with your home directory:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///home/your-user/oc-nonstop-router/src/index.js"],
  "provider": {
    "openai": {
      "options": {
        "headerTimeout": false,
        "timeout": false
      }
    }
  }
}
```

The plugin has no runtime npm dependencies. To check status from the clone, run `node ~/oc-nonstop-router/src/cli.js status`.

After editing the configuration, close and restart OpenCode. Configure only one plugin responsible for OpenAI authentication at a time, because multiple plugins can register hooks for the same provider.

## Add accounts

1. Run:

   ```bash
   opencode auth login --provider openai
   ```

2. Select **ChatGPT Pro/Plus (browser) - add account** or **ChatGPT Pro/Plus (device) - add account**.
3. Enter a name for the account and complete the authorization.
4. Repeat for each account. Use a different browser session or profile when signing in to another account.

The browser flow listens on `127.0.0.1:1455`. If that port is in use or the browser cannot reach it, use the device flow. When the router has no accounts and OpenCode already supplies an OpenAI OAuth credential, the provider loader can register that credential as the first account.

## Check account status

Run the npm command to list account names and availability without printing tokens:

```bash
npx --yes --package=oc-nonstop-router@1.0.1 nonstop-router status
```

Alternatively, install the command with `npm install -g oc-nonstop-router` and run `nonstop-router status`. Installing the command globally does **not** add the plugin to OpenCode's configuration.

Within OpenCode, ask the assistant to use the `nonstop_router_status` tool. It reports whether an account is available, rate-limited until a UTC timestamp, or needs a new login.

## How it works

1. The plugin registers OpenAI authentication methods and an OpenCode `auth.loader`. The router's transport is enabled when OpenCode provides OAuth credentials; API keys are not rotated.
2. An available account is selected. Its token is refreshed when necessary, and its credentials are applied to that request without switching a shared global credential. Account updates are serialized across processes.
3. Compatible Responses and Chat Completions requests to `api.openai.com` are sent to the ChatGPT Codex endpoint. The transport accepts initial HTTPS destinations only on `api.openai.com` and `chatgpt.com`.
4. On **HTTP 429 before a response is delivered**, the router records the reset indicated by response headers or the body and tries another account. Without a reset time, it uses increasing backoff. An `insufficient_quota` error without a known reset marks that account as exhausted for the current request while other accounts are tried.
5. If all valid accounts are temporarily limited, the router waits for the first available reset and retries. The wait can be cancelled. If no account can satisfy a quota error without a reset, that error is returned.
6. On **HTTP 401**, the router attempts a token refresh. If credentials remain invalid, it can mark that account as requiring login and try another. A **403** or a network failure is not automatically treated as a rate limit.

### Limitations

- The computer and OpenCode process must remain running while a request waits. The wait can be long when the provider reports a distant reset.
- Account switching happens before the response is delivered to OpenCode. If a streaming response has already started and fails partway through, the plugin cannot guarantee resumption at the same point and does not automatically replay that response.
- Already completed tool executions are not replayed. Continuation is not guaranteed if the OpenCode process exits.
- Only OpenAI/ChatGPT OAuth accounts are routed. Other providers and API keys are not rotated.
- Token refreshes performed by the router may leave OpenCode's native OAuth credential out of sync. If you later disable the router, you may need to authenticate again.
- Model availability, reset times, and endpoint behavior depend on OpenAI and may change.

## Account storage and security

Account credentials and rate-limit state are stored in:

```text
${XDG_DATA_HOME:-~/.local/share}/opencode/oc-nonstop-router/accounts.json
```

The plugin creates its directory with mode `0700` and account files with mode `0600`, uses atomic writes, and coordinates updates with `flock`. Tokens are stored in a local file; do not share the account file or its containing directory. Effective permissions depend on the filesystem and environment.

## Development

```bash
git clone https://github.com/rogerwindberg/oc-nonstop-router.git
cd oc-nonstop-router
npm test
```

The tests use artificial credentials and provider responses. The integration test installs a package tarball into an isolated OpenCode instance, so both `npm` and `opencode` must be available on `PATH`. To inspect the files that would be published, run `npm pack --dry-run`.

The main modules are `src/hooks.js` for OpenCode integration, `src/oauth.js` for authentication, `src/store.js` for account storage, `src/transport.js` for routing and retries, and `src/cli.js` for status.

## Credits and license

Nonstop Router builds on the original [rahadiana/opencode-multi-account](https://github.com/rahadiana/opencode-multi-account) project by rahadiana nugraha. Its MIT license is retained in [LICENSE-rahadiana](LICENSE-rahadiana). The OpenCode license notice is retained in [LICENSE-opencode](LICENSE-opencode).

This project is distributed under the [MIT License](LICENSE). OpenCode and OpenAI are projects of their respective owners.
