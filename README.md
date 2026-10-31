# Nonstop Router

An **OpenCode 1** plugin that routes OpenAI/ChatGPT OAuth requests across multiple accounts. When an account reaches a rate limit, Nonstop Router tries another account. If all accounts are temporarily limited, it waits for the earliest reset and retries the request without requiring another message.

## Features

- Add and name multiple OpenAI OAuth accounts using browser or device authentication.
- Automatically switch accounts on HTTP 429 and wait for temporary limits to reset.
- Respect provider reset information, check for manual quota resets while waiting, and allow users to cancel the wait.
- Refresh each account's token independently and coordinate storage across processes.
- View available usage windows, reset times, and reset credits without displaying credentials.
- Manage account order and toggle routing from the OpenCode terminal interface.

## Requirements

- OpenCode **1.19.3**, the version used by the integration tests. Other OpenCode 1 versions and OpenCode 2 have not been verified.
- Linux or Windows with **WSL**, with `flock` and `sh` available. Native Windows and macOS have not been tested.
- Node.js **20.3 or later** for the status command and tests. OpenCode installs npm plugins automatically into its cache.
- OpenAI/ChatGPT accounts with access to the OAuth flow and the models you intend to use. This plugin does not change provider limits or grant model access.

## Installation

Choose **one** of the options below. The examples show minimal configuration; merge them into your existing `opencode.json` or `opencode.jsonc` rather than replacing unrelated settings. Global configuration is stored in `~/.config/opencode/`; project configuration is stored in the project root. OpenCode merges configuration from both locations.

### Option 1: npm through OpenCode

Install the package for both the server and terminal interface with:

```bash
opencode plugin --global oc-nonstop-router@1.0.1
```

Alternatively, add it to the `plugin` array in `~/.config/opencode/opencode.json`:

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

For the interface, also add the same package to `~/.config/opencode/tui.json`:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["oc-nonstop-router@1.0.1"]
}
```

The examples pin the package version. To use the latest resolved version, replace `"oc-nonstop-router@1.0.1"` with `"oc-nonstop-router"`. The `opencode plugin --global` command configures both plugin entrypoints; add the `provider.openai.options` settings above separately if you need to wait for longer resets.

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

Also add the TUI entrypoint to `~/.config/opencode/tui.json`:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["file:///home/your-user/oc-nonstop-router/src/tui.js"]
}
```

The plugin has no runtime npm dependencies. To check status from the clone, run `node ~/oc-nonstop-router/src/cli.js status`. The committed `tui.js` is generated from `tui.tsx`; see [Development](#development) if you modify the interface.

After editing the configuration, close and restart OpenCode. Configure only one plugin responsible for OpenAI authentication at a time, because multiple plugins can register hooks for the same provider.

## Terminal commands and account management

The OpenCode terminal interface displays **Nonstop Router: ON** in green or **Nonstop Router: OFF** in red. It also displays the most recently fetched usage information for an available account; use `/nonstop status` for account-by-account details.

| Command | Action |
| --- | --- |
| `/nonstop` | Open the account configuration menu. |
| `/nonstop-enable` | Enable the configured account sequence and automatic failover. |
| `/nonstop-disable` | Disable routing and use the OpenCode native OpenAI account, without router failover or waiting. |
| `/nonstop-status` | List accounts and their available usage information. Select an account for details. |

The command palette also provides `/nonstop` for configuration and `/nonstop-enable`, `/nonstop-disable`, and `/nonstop-status`. These interface commands require the TUI plugin to be configured as described above. The TUI and router must run on the same machine and use the same `XDG_DATA_HOME`.

In the configuration menu, add the OpenAI OAuth account currently signed in to OpenCode, sign in to a new account using the browser or a device code, rename an account, change its position, or remove it from the sequence. Removing an account from the sequence keeps its stored login so it can be added again. A changed order is applied to subsequent requests. The ON/OFF state and sequence persist across restarts.

When disabled, an in-progress wait stops within approximately two seconds and the request continues using OpenCode's native account. The router still handles the OAuth transport for that account, including token refresh when needed. Re-enabling routing affects subsequent requests; it does not replay a response already in progress.

### Add accounts from the command line

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

Within OpenCode, the `nonstop_router_status` tool shows the ON/OFF state and whether each account is available, removed from the sequence, rate-limited until a UTC timestamp, or needs a new login. `/nonstop status` additionally fetches the provider's available usage windows.

### Usage limits

Usage is requested from the authenticated ChatGPT Codex usage endpoint for each account. OpenAI can return windows such as **5-hour** and **weekly**, daily windows, model-specific limits, and a count of available reset credits. The interface shows the reported usage percentage and reset time, labels each window according to its actual duration, and displays **unavailable** when a daily, weekly, or reset-credit value is not supplied. It never assumes a 5-hour window is daily. Status queries do not redeem reset credits.

The footer refreshes its account usage approximately every five minutes; `/nonstop status` requests current data. When a status check confirms that a limited account is available again, it updates the account state so a pending request can resume. An unavailable response, a disconnected account, or a network error results in unavailable usage rather than invented values. Usage values may change between refreshes.

## How it works

1. The plugin registers OpenAI authentication methods and an OpenCode `auth.loader`. The router's transport is enabled when OpenCode provides OAuth credentials; API keys are not rotated.
2. The first available account in the configured sequence is selected. Accounts removed from the sequence are skipped. Its token is refreshed when necessary, and its credentials are applied to that request without switching a shared global credential. Account updates are serialized across processes.
3. Compatible Responses and Chat Completions requests to `api.openai.com` are sent to the ChatGPT Codex endpoint. The transport accepts initial HTTPS destinations only on `api.openai.com` and `chatgpt.com`.
4. On **HTTP 429 before a response is delivered**, the router records the reset indicated by response headers or the body and tries another account. Without a reset time, it uses increasing backoff. An `insufficient_quota` error without a known reset marks that account as exhausted for the current request while other accounts are tried.
5. If all valid accounts are temporarily limited, the router waits for the first available reset and retries. While waiting, it checks the provider's usage status approximately every five minutes, so a request can resume earlier if the user manually resets a limit. The router resumes early only when the provider explicitly reports that usage is allowed and the limit is no longer reached. If the check fails or does not confirm recovery, the original deadline remains in effect. The wait can be cancelled. If no account can satisfy a quota error without a reset, that error is returned.
6. On **HTTP 401**, the router attempts a token refresh. If credentials remain invalid, it can mark that account as requiring login and try another. A **403** or a network failure is not automatically treated as a rate limit.

### Limitations

- The computer and OpenCode process must remain running while a request waits. The wait can be long when the provider reports a distant reset.
- Manual resets are detected while the original request is still pending. If the request or OpenCode process has already ended, start a new request to continue.
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

The tests use artificial credentials and provider responses. Integration tests install a package tarball into isolated OpenCode instances, so both `npm` and `opencode` must be available on `PATH`. The TUI interaction test also requires `tmux` and is skipped when it is unavailable. To inspect the files that would be published, run `npm pack --dry-run`.

After changing `src/tui.tsx`, regenerate the packaged interface before running tests:

```bash
npm install
npm run build
npm test
```

The main modules are `src/hooks.js` for OpenCode integration, `src/oauth.js` for authentication, `src/store.js` for account storage, `src/transport.js` for routing and retries, and `src/cli.js` for status.

## Credits and license

Nonstop Router builds on the original [rahadiana/opencode-multi-account](https://github.com/rahadiana/opencode-multi-account) project by rahadiana nugraha. Its MIT license is retained in [LICENSE-rahadiana](LICENSE-rahadiana). The OpenCode license notice is retained in [LICENSE-opencode](LICENSE-opencode).

This project is distributed under the [MIT License](LICENSE). OpenCode and OpenAI are projects of their respective owners.
