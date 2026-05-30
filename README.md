# pastepatch

A CLI for coding with ChatGPT's web UI: generate a full codebase prompt, paste
ChatGPT's JSON tool plan back into the terminal, and apply the requested file
edits locally.

## Install and run

Run without installing:

```bash
npx @nocdn/pastepatch --init
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
```

| flag | description |
| --- | --- |
| `--init` | ask what you want ChatGPT to implement, run `bunx @nocdn/ingest <path> --stdout`, wrap the task and digest with ChatGPT instructions, and copy the full prompt to the clipboard |
| `--edit` | read the ChatGPT JSON tool plan from the clipboard and apply the file edits |
| `--undo` | undo the most recent applied pastepatch change set |
| `--log`, `--last-log` | print the pastepatch log for the current directory |
| `--path <path>` | project path for `--init`; a positional path also works; defaults to the current directory |
| `-m`, `--message`, `--task <text>` | provide first-turn instructions for `--init` instead of being asked interactively |
| `-i`, `--include <pattern>` | forward an include pattern to `@nocdn/ingest`; repeatable |
| `-e`, `--exclude <pattern>` | forward an exclude pattern to `@nocdn/ingest`; repeatable |
| `--stdout` | print the `--init` prompt to stdout; still copies to clipboard unless `--no-clipboard` is set |
| `--no-clipboard` | do not copy the `--init` prompt; print it to stdout instead |
| `--dry-run` | validate and preview `--edit` tool calls without changing files |
| `-y`, `--yes` | apply `--edit` tool calls without prompting |
| `-h`, `--help` | show help |
| `-v`, `--version` | show version |

Anything after `--` in `--init` mode is forwarded directly to
`@nocdn/ingest`, for example:

```bash
pastepatch --init . -- --line-numbers --template node
```

## Workflow

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
   files. If the clipboard does not contain valid JSON in the expected tool
   format, it prints an error and does not change files. When changes are
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

`--edit` reads from the clipboard when run interactively, and from stdin when
input is piped.

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
