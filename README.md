# pastepatch

A CLI for coding with ChatGPT's web UI — either via clipboard JSON tool plans,
or via a remote **MCP server** exposed through Cloudflare Tunnel so ChatGPT can
call tools that read and edit files on your machine.

## Install and run

Run without installing:

```bash
npx @nocdn/pastepatch --init
```

If you use Bun, `bunx` works too:

```bash
bunx @nocdn/pastepatch --init
```

Or install globally to use `pastepatch` directly from any repo:

```bash
npm install -g @nocdn/pastepatch
```

This project uses npm for development.

## Usage

```bash
pastepatch --init [path] [options] [-- ingest-options]
pastepatch --edit [options]
pastepatch --undo
pastepatch --log
pastepatch --mcp [path] [options]
pastepatch --mcp --setup-tunnel
```

| flag | description |
| --- | --- |
| `--init` | ask what you want ChatGPT to implement, run `bunx @nocdn/ingest <path> --stdout` with an `npx -y` fallback, wrap the task and digest with ChatGPT instructions, and copy the full prompt to the clipboard |
| `--edit` | read the ChatGPT JSON tool plan from the clipboard and apply the file edits |
| `--undo` | undo the most recent applied pastepatch change set |
| `--log`, `--last-log` | print the pastepatch log for the current directory |
| `--mcp` | start local MCP + Cloudflare Tunnel (requires `cloudflared`; uses `~/.pastepatch/` after setup) |
| `--setup-tunnel` | one-time automated tunnel setup (login, create tunnel, DNS, save config) |
| `--path <path>` | project path for `--init` / `--mcp`; a positional path also works; defaults to the current directory |
| `--port <n>` | MCP listen port (default `8787`, or saved / `PASTEPATCH_MCP_PORT`) |
| `--hostname <host>` | public hostname for setup / display (e.g. `mcp.bartoszbak.org`) |
| `--tunnel-name <name>` | tunnel name for setup (default `pastepatch`) |
| `--tunnel-token <token>` | optional dashboard token override. Env: `PASTEPATCH_TUNNEL_TOKEN` |
| `--no-tunnel` | localhost only (still requires `cloudflared` installed) |
| `--auth-token <token>` | require `Authorization: Bearer` on MCP HTTP (ChatGPT usually wants No auth) |
| `--no-auth` | explicitly disable bearer auth |
| `-m`, `--message`, `--task <text>` | provide first-turn instructions for `--init` instead of being asked interactively |
| `-i`, `--include <pattern>` | forward an include pattern to `@nocdn/ingest`; repeatable |
| `-e`, `--exclude <pattern>` | forward an exclude pattern to `@nocdn/ingest`; repeatable |
| `--stdout` | print the `--init` prompt to stdout; still copies to clipboard unless `--no-clipboard` is set |
| `--no-clipboard` | do not copy the `--init` prompt; print it to stdout instead |
| `--dry-run` | validate and preview `--edit` tool calls without changing files |
| `-y`, `--yes` | apply `--edit` tool calls without prompting (except when the plan matches the last apply in the same directory) |
| `-h`, `--help` | show help |
| `-v`, `--version` | show version |

Anything after `--` in `--init` mode is forwarded directly to
`@nocdn/ingest`, for example:

```bash
pastepatch --init . -- --line-numbers --template node
```

## MCP mode (ChatGPT Developer Mode + Cloudflare Tunnel)

ChatGPT's web UI only connects to **remote HTTPS** MCP servers (Streamable HTTP
or SSE), not local stdio processes. pastepatch therefore:

1. Runs an MCP HTTP server on `127.0.0.1` (default port `8787`)
2. Runs `cloudflared` against a **named tunnel** so a stable hostname on your
   domain (e.g. `mcp.bartoszbak.org`) reaches that port

### Prerequisites

1. Domain on **Cloudflare DNS** (e.g. `bartoszbak.org`)
2. **cloudflared** installed — `--mcp` exits with install instructions if missing

```bash
# macOS
brew install cloudflared
```

Docs: [Install cloudflared](https://developers.cloudflare.com/tunnel/downloads/)

### One-time setup (automated)

```bash
bunx @nocdn/pastepatch --mcp --setup-tunnel
# optional: only the subdomain label (zone is read from cloudflared login)
bunx @nocdn/pastepatch --mcp --setup-tunnel --hostname pastepatch
# or a full FQDN:
bunx @nocdn/pastepatch --mcp --setup-tunnel --hostname pastepatch.bartoszbak.org
```

This runs the official **locally-managed tunnel** CLI flow and saves config for later:

1. `cloudflared tunnel login` (browser — pick your domain) if not already authenticated
2. Reads the authorized zone from `~/.cloudflared/cert.pem` and only asks for the **subdomain** (e.g. `pastepatch` → `pastepatch.bartoszbak.org`)
3. `cloudflared tunnel create pastepatch` (or reuses that name)
4. Writes `~/.pastepatch/cloudflared-config.yml` (hostname → `http://127.0.0.1:8787`)
5. `cloudflared tunnel route dns pastepatch <hostname>`
6. Saves `~/.pastepatch/mcp-tunnel.json` (tunnel id, hostname, zone, credentials path, port)

Do **not** use quick tunnels (`trycloudflare.com`): unstable URL and no SSE.

Docs: [Create a locally-managed tunnel](https://developers.cloudflare.com/tunnel/advanced/local-management/create-local-tunnel/)

### Run the MCP server

From the project you want ChatGPT to edit:

```bash
bunx @nocdn/pastepatch --mcp
```

Uses the saved tunnel config automatically. Starts:

- Local MCP: `http://127.0.0.1:8787/mcp`
- Public URL: `https://mcp.bartoszbak.org/mcp` (your hostname from setup)
- Legacy SSE: `https://mcp.bartoszbak.org/sse`

### Connect ChatGPT

1. ChatGPT → **Settings → Security and login** → enable **Developer mode**
2. **Settings → Plugins** → create a developer-mode app
3. MCP server URL: `https://mcp.bartoszbak.org/mcp` (your hostname)
4. Authentication: **No authentication** (keep the URL private)
5. In a chat, open **+ → Developer mode** and enable your app

OpenAI docs: [ChatGPT developer mode](https://developers.openai.com/api/docs/guides/developer-mode)

### MCP tools

| tool | read-only | description |
| --- | --- | --- |
| `start_here` | yes | agent role, project root, tool guide — call at session start |
| `project_info` | yes | absolute project root bound to this server |
| `list_directory` | yes | list a directory (relative path) |
| `find_files` | yes | find files by name (`fd`, else `find`) |
| `search` | yes | search contents (`rg`, else `grep`) |
| `read_file` | yes | read a UTF-8 file (relative path) |
| `create_file` | no | create or overwrite a file |
| `replace_in_file` | no | exact string replace (optional `replaceAll`) |
| `append_to_file` | no | append text |
| `delete_file` | no | delete file or directory |
| `move_file` | no | rename/move within the project |
| `undo_last_change` | no | undo the most recent pastepatch change set |
| `handoff` | yes | detailed session report in one markdown code block for the next chat |

Paths are sandboxed the same way as `--edit` (relative only, no `..`, no
symlinks). Write tools create undo history under `.git/pastepatch/history` (or
`.pastepatch/history`).

### Security

**Path sandbox (default ON):** tools can only read/write under the bound project directory
(and subfolders). Absolute paths and `..` are rejected. Lift with `--allow-outside`
(discouraged).

Anyone who can reach the public MCP URL can invoke write tools. Mitigations:

- Use a non-guessable subdomain and keep the tunnel token secret
- Only run `--mcp` while you are actively coding
- Optionally put [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) in front of the hostname
- Optional `--auth-token` for non-ChatGPT clients (ChatGPT No-auth mode will not send it)

Help:

```bash
pastepatch --help          # all modes
pastepatch --mcp -h        # MCP options only
pastepatch --mcp --help    # same
```

## Clipboard workflow

1. From the project you want ChatGPT to edit, generate the initial prompt:

   ```bash
   pastepatch --init
   ```

   The CLI asks what you want ChatGPT to implement in the first turn. Type or
   paste the instructions, then press Enter on an empty line. The full prompt is
   copied to your clipboard, including your requested change, the available
   tools, follow-up workflow guidance, and the codebase digest. Paste it into
   ChatGPT.

   To provide the first-turn task non-interactively:

   ```bash
   pastepatch --init --task "Add a --json flag and update the README"
   ```

   The generated prompt tells ChatGPT that you will keep using the same
   conversation for follow-up coding tasks. For follow-ups, ChatGPT should treat
   the original digest plus successfully applied tool plans as its working model
   of the repo, and ask you for a fresh `--init` digest if it becomes uncertain.

2. ChatGPT should respond with a fenced JSON tool plan first, such as:

   ```json
   [
     {
       "tool": "replace_in_file",
       "path": "README.md",
       "old": "old exact text",
       "new": "new exact text"
     },
     {
       "tool": "create_file",
       "path": "src/example.js",
       "content": "export const ok = true;\n"
     }
   ]
   ```

   If ChatGPT includes notes, explanations, disclaimers, test instructions, or
   answers to your questions, they should come after the JSON code block. The
   JSON tool plan should always be the first code block in the response.

3. Apply the tool plan locally:

   ```bash
   pastepatch --edit
   ```

   Copy ChatGPT's fenced JSON code block with the code block copy button before
   running the command. The CLI reads the tool plan from your clipboard,
   previews the parsed tool calls, and asks for confirmation before changing
   files. If the pasted plan matches the most recent apply in the same
   directory (for example, you forgot to copy a new ChatGPT block), pastepatch
   prints a clear warning and requires an explicit `y` to re-apply, even when
   `--yes` is set. If the clipboard does not contain valid JSON in the expected
   tool format, it prints an error and does not change files. When changes are
   applied, pastepatch stores an undo snapshot under `.git/pastepatch/history`
   if the current directory is inside a git repository, so the history is not
   tracked by git.

4. Undo the last applied pastepatch change set if needed:

   ```bash
   pastepatch --undo
   ```

For a non-interactive dry run:

```bash
pbpaste | pastepatch --edit --dry-run
```

In Windows PowerShell:

```powershell
Get-Clipboard -Raw | pastepatch --edit --dry-run
```

To read a saved tool plan file in PowerShell:

```powershell
Get-Content -Raw .\chatgpt-tools.json | pastepatch --edit --dry-run
```

`--edit` reads from the clipboard when run interactively, and from stdin when
input is piped.

On Windows, pastepatch invokes npm and Bun command shims through `cmd.exe`, so
PowerShell users can run the CLI with either `npx` or `bunx`. Clipboard access
uses PowerShell's `Get-Clipboard` and `Set-Clipboard` cmdlets when available.

To inspect what happened in the current directory:

```bash
pastepatch --log
```

## ChatGPT tool format

`--edit` accepts either a raw JSON array or an object with a `tools` array. It
also accepts the JSON inside a Markdown fenced code block.

Supported tools:

| tool | required fields | description |
| --- | --- | --- |
| `create_file` | `path`, `content` | create or overwrite a UTF-8 text file |
| `replace_in_file` | `path`, `old`, `new` | replace an exact string in a UTF-8 text file |
| `append_to_file` | `path`, `content` | append UTF-8 text to a file |
| `delete_file` | `path` | delete an existing file or directory |
| `move_file` | `from`, `to` | rename or move a file or directory |

`replace_in_file` replaces one occurrence by default. If `old` appears more
than once, the CLI stops with an error unless the call sets
`"replaceAll": true`.

For safety, paths must be relative, must not be `.`, must not contain `..`,
and must not escape the current directory. Tool calls do not operate on
symbolic links. `delete_file` fails when the target path does not exist.
Details and errors are written to `.pastepatch.log` in the current directory.
Undo history for applied edits is written under `.git/pastepatch/history` when
inside a git repository, or `.pastepatch/history` outside git repositories.

## Develop

```bash
npm install
npm start
npm test
```

The CLI entry point lives in [`bin/cli.js`](./bin/cli.js). The package is built
with plain Node.js and npm for maximum runtime compatibility.

## Publishing

This project includes a GitHub Actions workflow at
[`.github/workflows/publish.yml`](./.github/workflows/publish.yml) that publishes
the package to npm with [trusted publishing](https://docs.npmjs.com/trusted-publishers)
on pushes to `main`, as long as the version in `package.json` is not already on npm.
`package.json` sets `publishConfig.access` to `public`, so scoped packages are
published publicly by default.

To enable it once:

1. Push the repository to GitHub.
2. On npmjs.com, configure the package as a trusted publisher pointing at the
   `publish.yml` workflow in this repository.
3. Bump the version in `package.json` and push - the workflow will publish.
