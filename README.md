# multi-xxl-job-mcp

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js >= 26](https://img.shields.io/badge/node-%3E%3D26-green.svg)](https://nodejs.org/)
[![npm](https://img.shields.io/npm/v/@skylerfee/multi-xxl-job-mcp.svg)](https://www.npmjs.com/package/@skylerfee/multi-xxl-job-mcp)

MCP Server for [XXL-JOB](https://github.com/xuxueli/xxl-job) Admin — lets AI assistants manage XXL-JOB scheduled tasks directly over the Model Context Protocol.

**Repository: [multi-xxl-job-mcp](https://github.com/SkylerFee/multi-xxl-job-mcp)** · **中文文档: [README.zh-CN.md](README.zh-CN.md)**

> Forked from [shaguocgl/mcp-xxl-job](https://github.com/shaguocgl/mcp-xxl-job), renamed to `multi-xxl-job-mcp` and maintained independently.
> The upstream npm package and Glama listing are unrelated to this project.

## Features

- **Executor group management** — list executor groups and their live machine addresses
- **Full job lifecycle** — query, create, update, delete, start and stop scheduled jobs
- **Manual triggering** — run a job immediately, optionally overriding run parameters or target executor address
- **Schedule preview** — compute upcoming fire times from a Cron expression without touching the scheduler
- **Execution logs** — paginate trigger records and pull log bodies incrementally
- **Session handling** — automatic login, cookie session maintenance, and one automatic re-login on expiry
- **No silent field loss** — updates use a read-merge-write strategy

## MCP tools

Every tool except `list_instances` **requires both `system` and `env`**. This is deliberate: mistakes on scheduled jobs (deletion especially) are unrecoverable, so explicit addressing prevents "forgot to switch environments".

| Tool | Purpose |
|------|---------|
| `list_instances` | List all systems and environments (**never returns credentials**). Call this first to discover valid targets |
| `list_job_groups` | Paginate executor groups |
| `list_jobs` | Paginate jobs, with filters for executor group, status, description, etc. |
| `get_job` | Fetch the full configuration of one job |
| `add_job` | Create a job (schedule types: CRON / FIX_RATE / NONE) |
| `update_job` | Update a job; omitted fields keep their current values |
| `remove_job` | Delete a job |
| `start_job` | Enable scheduling for a job |
| `stop_job` | Disable scheduling for a job |
| `trigger_job` | Run a job once immediately |
| `preview_next_trigger_times` | Compute upcoming fire times |
| `list_job_logs` | Paginate execution log records |
| `get_job_log_content` | Pull log body incrementally |

## Requirements

- **Node.js** >= 26 (see `.node-version`; CI uses the same version)
  > No backward compatibility below this version is promised. Earlier releases required >= 18.15
  > (older versions lack `Headers.prototype.getSetCookie`, so login "succeeds" but the cookie is
  > never stored). The project now tracks the current development version as its baseline.
- **XXL-JOB Admin** >= 2.3.0

## Installation

**Option 1: from npm (recommended)**

```bash
# stable release
npm install -g @skylerfee/multi-xxl-job-mcp

# preview release (beta channel)
npm install -g @skylerfee/multi-xxl-job-mcp@beta

# or run it without installing
npx -y @skylerfee/multi-xxl-job-mcp@latest
```

**Option 2: from source** (when you need to modify or debug the code)

```bash
git clone https://github.com/SkylerFee/multi-xxl-job-mcp.git
cd multi-xxl-job-mcp
npm install && npm run build && npm link
```

> Upgrading from source: `git pull && npm install && npm run build` — no need to re-link.

## Configuration

### Core concepts

Configuration has **two levels**: business system (`system`) → environment (`env`).

| Concept | Meaning |
|---------|---------|
| **System** | A business system such as `order` or `payment`; this is the `system` tool argument |
| **Environment** | One scheduler connection under a system, such as `dev` or `prod`; this is the `env` argument |
| **Target** | A single XXL-JOB Admin uniquely identified by `system` + `env` |
| **Alias** | Human-readable system name (e.g. "Order System"). **Display only — never used for addressing** |

A `system` may have any number of `env` entries, each pointing at an independent scheduler. Sessions and login state are isolated per target.

### Generating a config file

```bash
multi-xxl-job-mcp init      # interactive; can add multiple environments/systems in one session
multi-xxl-job-mcp add       # append one environment or system to an existing config
multi-xxl-job-mcp help      # list all commands
```

`init` does not exit after the first entry — it asks what to do next:

```
接下来要做什么？
  i  在当前系统下再加一个环境（instance）
  s  再加一个系统（system）
  d  结束（默认）
```

Everything is written **once at the end**, so an interrupted session (Ctrl-D) never leaves a
half-written config behind.

`add` appends to an existing config, touching only the target node — other systems, other
environments and `alias` values are preserved. If the config file does not exist it reports an
error instead of creating one; that is `init`'s job.

This interactively writes the config to a single, memorable path across all platforms:

```
$XDG_CONFIG_HOME/multi-xxl-job-mcp/config.yaml
```

When `XDG_CONFIG_HOME` is unset this resolves to `~/.config/multi-xxl-job-mcp/config.yaml` (`~` is `%USERPROFILE%` on Windows).

Using one path instead of three platform-specific ones is deliberate: macOS `Application Support` is a GUI convention that command-line tools generally ignore (`gh`, `opencode` and `redis-mcp` all use `~/.config`). With a single path there is one documented location, and a path from someone else's console is directly usable when troubleshooting.

The server prints the absolute path it actually loaded on startup. See [config.example.yaml](./config.example.yaml) for a full example.

### Config file format

YAML by default; JSON is accepted by the same parser. Minimal example:

```yaml
systems:
  order:
    alias: Order System
    instances:
      dev:
        url: http://127.0.0.1:8080/xxl-job-admin
        username: admin
        password: 123456
      prod:
        url: https://order-xxl.example.com/xxl-job-admin
        username: ${ORDER_PROD_USER}
        password: ${ORDER_PROD_PASS}
        timeoutMs: 30000
```

| Field | Required | Description |
|-------|----------|-------------|
| `url` | ✅ | Scheduler URL; trailing slashes are stripped |
| `username` | ✅ | Login user name |
| `password` | ✅ | Login password |
| `timeoutMs` | ❌ | HTTP timeout in milliseconds, default 15000 |
| `alias` | ❌ | System display name; uniqueness is not enforced |

**Naming rules**: `system` and `env` keys may contain only letters, digits, underscores and hyphens.

**Credential safety**: accounts and passwords **never appear in tool output or logs**. `list_instances` returns addressing information only; if the `url` embeds `user:pass@`, it is stripped before display and flagged with `urlCredentialsEmbedded: true` so you can correct the pattern.

Any field value supports `${VAR}` interpolation. Prefer writing passwords as `${MY_PASSWORD}` and setting the variable in your MCP client's `env` so the config file itself holds no plaintext. An unset variable is a hard error — it will not silently log in with an empty string. If the file is readable by group or others, the server warns on startup.

### MCP client setup

Add this to your MCP client (Claude Desktop, Cursor, Qoder, etc.):

```json
{
  "mcpServers": {
    "xxl-job": {
      "command": "multi-xxl-job-mcp"
      // No env needed: connection details come from the config file
      // If the config uses ${VAR} interpolation, set those variables here, e.g.:
      // "env": { "ORDER_PROD_USER": "admin", "ORDER_PROD_PASS": "<password>" }
    }
  }
}
```

If you prefer not to register a global command, point `command` at the built entry file instead:

```json
{
  "mcpServers": {
    "xxl-job": {
      "command": "node",
      "args": ["/absolute/path/to/multi-xxl-job-mcp/dist/src/server.js"]
      // Connection details come from the config file; no env needed
    }
  }
}
```

> **Windows**: use forward slashes or doubled backslashes, e.g. `C:/tools/multi-xxl-job-mcp/dist/src/server.js`.

> **Releasing**: see [docs/RELEASING.md](docs/RELEASING.md). Publishing uses npm Trusted Publishing (OIDC); the repository stores no npm token.

## Usage examples

Once configured, you can drive XXL-JOB in natural language. Because every tool needs a target, mention the system and environment in your request:

```
List all available systems and environments
```

```
Show me the scheduled jobs in the order system, dev environment
```

```
Compare the job configuration of the order system between dev and prod
```

```
Create a job: order system, dev environment, executor group=demo-server, description=data sync, Cron=0 0 2 * * ? *, Handler=syncJobHandler
```

```
Stop the schedule of job id=5 in the order system, dev environment
```

```
Show the last 10 execution logs for job id=3 in the order system, prod environment
```

```
Preview the upcoming fire times for Cron 0 0/30 * * * ? in the prod environment
```

## Development

```bash
# clone
git clone https://github.com/SkylerFee/multi-xxl-job-mcp.git
cd multi-xxl-job-mcp

# install dependencies
npm install

# compile
npm run build

# lint (ESLint; rules in eslint.config.js — local only, CI does not run lint)
npm run lint

# run
npm start

# watch mode (recompile on change)
npm run dev
```

### Local debugging (Mock + Inspector)

Three scaffold scripts cover debugging without a real scheduler. **All of them require `npm run build` first.**

```bash
# 1. Start a mock XXL-JOB Admin (fixed port 18080, also writes an isolated debug config)
npm run dev:mock
npm run dev:mock -- --port 18081      # use another port if 18080 is taken
npm run dev:mock -- --no-config       # start the mock only, skip the config file
```

`dev:mock` does two things:

- Starts a mock Admin on `127.0.0.1:18080` (credentials `admin` / `mock-pass`)
- Writes a config to `tmp/dev-home/.config/multi-xxl-job-mcp/config.yaml` containing `demo/dev` and `demo/prod`
  **both pointing at the same mock** — this lets you exercise the core "reuse per target, isolation across targets" behavior, which a single-environment config cannot show.

> The config lives under `tmp/dev-home/` (covered by `.gitignore`) and **never touches your real `~/.config`**.

```bash
# 2. Debug with the official MCP Inspector (separate terminal)
npm run dev:inspect                                        # Web UI, opens a browser
npm run dev:inspect -- --tui                               # terminal UI
npm run dev:inspect -- --cli --method tools/list           # list every tool and its schema
npm run dev:inspect -- --cli --method tools/call --tool-name list_instances
npm run dev:inspect -- --cli --method tools/call --tool-name list_jobs \
  --tool-arg system=demo --tool-arg env=dev --tool-arg page=1 --tool-arg pageSize=5

# 3. Run read-only client checks against the mock (like test:client, without setting HOME)
npm run dev:client                    # demo/dev
npm run dev:client -- demo prod       # explicit system and env
```

`dev:inspect` places arguments in the order the Inspector requires; you only supply your own flags:

- **Mode flags** (`--cli` / `--tui` / `--web`) go first — a hard requirement of the Inspector
- **The server command** goes before variadic options — options like `--tool-arg` swallow every following token, so a server command placed after them fails with `Invalid parameter format: /path/to/node`

To troubleshoot argument handling, `--print-args` prints the final command without starting the Inspector:

```bash
npm run dev:inspect -- --print-args --cli --method tools/call --tool-name list_jobs --tool-arg system=demo
```

`dev:inspect` and `dev:client` read the `tmp/dev-home` config by default, staying consistent with `dev:mock`. To talk to a real scheduler, add `--real-home` so they read your `~/.config`:

```bash
npm run dev:inspect -- --real-home
npm run dev:client -- --real-home
```

**Why the Inspector is not a devDependency**: it is a convenience tool, pulled on demand via `npx`. Installing it would bloat `node_modules` and slow `npm ci`, and neither the runtime nor the tests need it. It uses your normal npm cache, so the Inspector is only downloaded once.

> **Schema portability check**: `npm run smoke` scans every tool's inputSchema and rejects array-style `type` declarations such as `type: ["number","string"]`. They are legal JSON Schema but not portable — clients that map tool schemas onto a single-`type` dialect (such as the OpenAPI subset used for Gemini function declarations) may reject the whole tool or silently drop the constraint. Use `anyOf` when a field accepts multiple types.

> **Breakpoints**: run `node --inspect-brk dist/src/server.js`, then attach from Chrome via `chrome://inspect`. For iterating, run `npm run dev` (`tsc --watch`) in another terminal.
> ⚠️ In stdio mode **stdout is the JSON-RPC channel** — debug output must go to `console.error`, or it corrupts the protocol stream.

### Tests

```bash
# Run every offline test (iterates all test:* scripts in package.json, skipping test:client)
npm test

# Or run them individually:
# smoke test (no XXL-JOB needed; verifies tool registration)
npm run smoke

# config parsing unit tests (pure functions)
npm run test:config

# target registry unit tests (injected fake client)
npm run test:registry

# init subcommand unit tests
npm run test:cli

# local debugging scaffold tests (fixed port, argument validation)
npm run test:dev

# end-to-end integration test (two mock targets, verifies isolation)
npm run test:integration

# read-only run against a real scheduler (needs a config file and reachable Admin)
npm run test:client                                  # defaults to order/dev
node dist/tests/test-client.js payment prod           # explicit system and environment
```

## Project layout

```
multi-xxl-job-mcp/
├── src/
│   ├── server.ts      # MCP server entry; registers all tools
│   ├── registry.ts    # target registry: (system, env) -> client with login state
│   ├── cli.ts         # init subcommand
│   ├── client.ts      # XXL-JOB Admin HTTP client
│   ├── config.ts      # config parsing, interpolation, validation, platform paths
│   └── models.ts      # data structures and validation logic
├── tests/
│   ├── config.test.ts       # config parsing unit tests
│   ├── registry.test.ts     # target registry unit tests
│   ├── cli.test.ts          # init subcommand unit tests
│   ├── smoke.ts             # smoke test (tool registration + dual-argument checks)
│   ├── integration.ts       # integration test (two mock targets)
│   ├── test-client.ts       # read-only checks against a real scheduler
│   ├── regression.test.ts   # regression tests for fixed fragility points
│   ├── dev-scaffold.test.ts # local debugging scaffold tests
│   └── mock-admin.ts        # mock Admin server
├── docs/
│   ├── ARCHITECTURE.md   # architecture and behavior (Chinese)
│   ├── RELEASING.md      # release process (Chinese)
│   ├── specs/            # design documents
│   └── adr/              # architecture decision records
├── scripts/
│   ├── test-all.mjs      # run every test:* script sequentially
│   ├── release-policy.mjs # release identity and artifact validation
│   ├── dev-mock.mjs      # local debugging: start mock Admin + write isolated config
│   ├── dev-inspect.mjs   # local debugging: convenience wrapper for MCP Inspector
│   └── dev-client.mjs    # local debugging: read-only checks against the mock
├── eslint.config.js      # ESLint flat config
├── config.example.yaml   # example config
├── package.json
└── tsconfig.json
```

## Tech stack

- **Runtime**: Node.js >= 26 (see `.node-version`)
- **Language**: TypeScript
- **MCP SDK**: @modelcontextprotocol/sdk
- **Schema validation**: Zod
- **Transport**: stdio

## License

[MIT](./LICENSE) © 2026

---

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
