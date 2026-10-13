# easySCP

Friendly, fast file transfers over SSH. Save a machine once, then send, receive and browse files without typing `scp` commands.

Works the same on macOS, Linux and Windows.

## Install

```sh
# macOS and Linux
curl -fsSL https://github.com/pentoshi007/easySCP/releases/latest/download/install.sh | sh

# Windows (PowerShell)
irm https://github.com/pentoshi007/easySCP/releases/latest/download/install.ps1 | iex

# Homebrew
brew install pentoshi007/tap/easyscp

# npm (Node.js 22 or newer)
npm install -g @pentoshi/easyscp
```

The install scripts download a standalone binary that needs nothing else, check it against the release checksums, put it on your `PATH` and set up tab completion. Set `EASYSCP_INSTALL_DIR` to choose the folder or `EASYSCP_VERSION` to pin a version. You can also download the binaries for x64 and arm64 from the [releases page](https://github.com/pentoshi007/easySCP/releases).

Every method installs two commands: `easyscp` and the shorter `escp`.

## Updating

```sh
easyscp update
```

This updates easyscp the same way it was installed: it downloads, verifies and swaps in the new binary, or runs npm or Homebrew for you. easyscp checks for a new release once a day and tells you when one is out.

## Quick start

```sh
easyscp add            # save a machine and how to log in
easyscp send prod      # pick local files, then a remote folder
easyscp get prod       # pick remote files, then a local folder
easyscp copy           # copy from one machine to others
easyscp browse prod    # side-by-side browser for both computers
easyscp                # interactive menu
```

Leave out an argument and easyscp asks for it with a picker. You can still pass everything on the command line:

```sh
easyscp send prod ./dist -t /var/www --overwrite
easyscp get prod '/var/log/*.log' -t ./logs
easyscp copy web1:/srv/app.tar web2 web3:/opt -t /srv
```

## Commands

| Command | Aliases | Purpose |
| --- | --- | --- |
| `send [machine] [files...]` | `up`, `push`, `upload` | Upload files or folders |
| `receive [machine] [paths...]` | `get`, `down`, `pull`, `download` | Download files or folders |
| `copy [from[:paths]] [to[:folder]...]` | `cp`, `relay` | Copy from one machine to others |
| `browse [machine]` | `open`, `files` | Side-by-side file browser |
| `add [user@host[:port]]` | `new` | Save a machine |
| `edit [name]` | | Change a saved machine |
| `remove [name...]` | `rm`, `delete` | Forget saved machines |
| `list` | `ls`, `hosts` | Show saved machines (`--json`) |
| `test [name]` | `ping`, `check` | Check that you can connect and log in |
| `import` | | Import machines from `~/.ssh/config` |
| `history` | `log` | Recent transfers, pick one to run again (`--json`, `--clear`) |
| `update` | `upgrade` | Update easyscp to the latest release |
| `completion [install\|uninstall\|<shell>]` | | Set up tab completion, or print a script for bash, zsh, fish or PowerShell |

Transfer flags: `-t, --to <dir>` sets the destination folder. `--overwrite`, `--skip`, `--newer`, `--rename` and `--resume` decide what happens when a file already exists. `-y, --yes` accepts the defaults without asking. Run `easyscp <command> --help` for details.

## Features

- Logs in with your SSH agent, a key file or a password. It tries keys and the agent automatically. Passwords and key passphrases are kept in the OS keychain.
- Verifies host keys on first use and refuses a changed key unless you confirm it. Keys are stored in easyscp's own `known_hosts`, and your `~/.ssh/known_hosts` is read too.
- Reads `~/.ssh/config`, including `ProxyJump`.
- Fuzzy file pickers for local and remote files. `ctrl+f` searches subfolders. You can drag and drop or paste paths.
- Fast, pipelined SFTP transfers with live progress. Each file is written to a temporary name and renamed when complete, so an interrupted transfer never leaves a half-written file under the real name.
- Interrupted transfers resume where they stopped.
- `copy` moves files between machines that can't reach each other. Your computer downloads each file once and uploads it to every destination at the same time. Data is staged in a private cache that is deleted as each file finishes. If one machine drops, easyscp reconnects and resumes from the cache without downloading again.
- The browser lets you copy, rename, delete, create folders and filter on both sides. Press `?` for its keys.

## Scripting

Without a terminal, easyscp never prompts. It prints plain text, writes errors to stderr and exits with:

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | Error or partial transfer |
| `2` | Invalid usage |
| `130` | Cancelled |

## Tab completion

The first time you run easyscp in a terminal, it sets up tab completion for the shell you are using (bash, zsh, fish or PowerShell) and tells you where. Commands and machine names then complete with tab. The setup is a marked block in your shell profile that loads a script kept up to date by easyscp.

```sh
easyscp completion install [shell]    # set it up again, or for another shell
easyscp completion uninstall          # remove it and stop setting it up
easyscp completion zsh                # print the script to manage it yourself
```

## Environment

| Variable | Effect |
| --- | --- |
| `EASYSCP_HOME` | Where machines, history and host keys are stored (default `~/.config/easyscp`, `%APPDATA%\easyscp` on Windows) |
| `EASYSCP_SECRETS=file` | Store secrets in a private file instead of the OS keychain |
| `EASYSCP_DEBUG=1` | Write an SSH debug log to `debug.log` in the easyscp folder |
| `EASYSCP_ASCII=1` | Use ASCII symbols only |
| `EASYSCP_NO_COMPLETION=1` | Don't set up tab completion automatically |
| `EASYSCP_NO_UPDATE_CHECK=1` | Don't check for new releases |
| `NO_COLOR` | Disable colors |

When no OS keychain is available, secrets go to a file that only your user can read. Treat that file like a private key.

## Development

```sh
git clone https://github.com/pentoshi007/easySCP.git && cd easySCP
npm ci
npm run check           # typecheck, lint and tests
npm run dev             # rebuild dist/ on change
npm install -g .        # use your build as easyscp
npm run build:binary    # standalone binary in release/ (needs Node.js 25.5+)
```

Pushing a `v*` tag that matches `package.json` builds and tests the binaries on every platform, then publishes to npm, GitHub Releases and the Homebrew tap.

## License

MIT
