# Benbot

Personal skills and selected GitHub skills, managed by **Benbot**. This repository lives at `~/Development/benbot`; the agent directories contain symlinks into it.

```text
skills/                 Skills you author and commit here
vendor/                 Downloaded skills, restored from the lockfile and ignored by Git
skills.lock.json        GitHub repository, folder, ref, exact commit and content hashes
SOUL.md                 Shared global instructions for Codex and Claude
lib/                    The benbot npm package
benbot.local.json       Optional local checkout links (ignored by Git)
```

## Set up this machine

Requires Node.js 20 or newer. GitHub CLI authentication (`gh auth login`) is used when available; `GH_TOKEN` or `GITHUB_TOKEN` also work. Public repositories can be accessed without authentication, with lower API limits.

```sh
cd ~/Development/benbot/lib
npm ci
npm install --global .
benbot install
```

`benbot install` uses your cloned repository and remembers its absolute location in `~/.config/benbot/config.json` (or `$XDG_CONFIG_HOME/benbot/config.json`). The default is `~/Development/benbot`; for another location, run `benbot install --root /path/to/skills`. No initialization step is needed.

After that, run commands from anywhere. Explicit commands use plain output. Running `benbot` alone opens the action menu; adding or updating multiple skills opens a picker (Space to toggle, A to toggle all, Enter to confirm). A single available skill is selected automatically. `benbot install` installs everything without a picker:


```sh
benbot                         # Interactive menu
benbot add anthropics/skills    # Discover SKILL.md folders and select skills
benbot add owner/repo --ref main --skill example
benbot list
benbot check
benbot update                   # Select changed skills
benbot update example
benbot new my-workflow          # Ask for description; create and link
benbot link ~/code/project/skills/my-workflow
benbot remove example
```

`add`, `update`, `new`, and `link` also install their links. `install` restores missing downloads at their **locked commits** and links all selected skills into `~/.agents/skills/<name>` and `~/.claude/skills/<name>`. Existing local vendor files need no network access. Private sources are marked in the lockfile. Missing private skills are skipped with a notice if GitHub access is unavailable; other skills still install. Authenticate with an account that has access and rerun install to restore them. Existing files or links owned by another setup cause an explicit conflict; Benbot never adopts or deletes them silently.

Use `--all` or repeat `--skill <name>` for non-interactive selection, `remove <name> --yes` for removal, and `new <name> --description 'When to use it'` for non-interactive creation. `--root /path` overrides the repo for one command (`install` also remembers it); `BENBOT_HOME` overrides the saved configuration. Explicit local paths are relative to the current directory.

## Sharing and updating

Commit `skills/`, `SOUL.md`, and `skills.lock.json`. Keep `vendor/` out of Git; install rebuilds it from the lockfile. Clone this repository anywhere on another machine, install the package from `lib/`, then run `benbot install --root /path/to/skills`. The location can differ between machines.

Downloads use GitHub's commit, tree, and blob APIs. Only selected skill-folder files are downloaded, without a clone, repository archive, or Git history. Each file's Git blob hash is verified, executable bits and binary contents are preserved, and installation verifies the locked content hash. `check` compares folder tree hashes against the tracked ref so unrelated upstream commits don't count as skill updates. Updates are explicit; review the lockfile diff before committing.

The `benbot` package is currently installed from this checkout; it has not been published to npm. Once published under an available name, a registry install can replace the local package install.

## Local edits and checkouts

Author personal skills under `skills/<name>/SKILL.md`. `benbot new` creates a minimal template and links it immediately. Folder names must match the frontmatter `name`.

`benbot link <folder>` records an absolute path in ignored `benbot.local.json`, for skills maintained alongside code. Repeat that command with the appropriate checkout path on each machine. Local links must have unique names; overriding a downloaded skill with a local checkout is not yet supported.

Updates, installs, and removal refuse to overwrite modified vendor files, including extra files created by a skill's scripts. Preserve changes in a personal skill or an upstream fork before updating. Local checkout and personal skill contents are never updated from GitHub by Benbot.

## Current boundaries

- GitHub repositories only. Discovery reads every `SKILL.md` in the repository; skills with malformed frontmatter are skipped with their file path and a concise warning; valid skills remain selectable. Network and authentication failures still stop discovery.
- A download includes files within the selected folder. Dependencies outside that folder are not followed.
- Symlinks, Git submodules, and Git LFS files inside downloaded skills are rejected explicitly.
- Each skill's download is staged before replacement. Completed skills remain installed if a later skill in a batch fails; rerun to finish.
- Only one mutating command runs per repo. After an interrupted process, remove `.benbot-busy/` only when no Benbot process remains. Inspect any `.benbot-stage-*` directory before deleting it; an interrupted replacement may contain a backup.
- Existing Stow/Vercel installations are not automatically migrated. Their local edits and provenance need to be preserved before switching their agent links.

## Develop the CLI

```sh
cd lib
npm ci
npm test
npm run check
npm pack --dry-run
```

## Shared instructions

`SOUL.md` is the single source for global agent instructions. `benbot install` symlinks it to `~/.codex/AGENTS.md` and `~/.claude/CLAUDE.md` (respecting `CODEX_HOME` and `CLAUDE_CONFIG_DIR` when set). Existing unrelated files or links cause a conflict instead of being overwritten. Move those aside after preserving any instructions you want in `SOUL.md`.

Run `benbot soul` from anywhere to open `SOUL.md` in Neovim. Changes are immediately shared through both symlinks; commit this file with your skills for other machines. Installation or editing creates a starter file only when it is missing. Editing never resets an existing file.

`benbot remove` works for downloaded skills, personal skills, and local links. Removing a personal or downloaded skill deletes its managed folder and agent links. Removing a linked skill unregisters it and removes its links while preserving the external checkout. The picker includes every kind of skill, even personal skills with malformed metadata.

## Repo discovery cache

`benbot add` caches discovered skills in gitignored `.benbot-cache/repos/`, separately for each repository and ref. On a repeat interactive visit, cached choices appear immediately while GitHub refreshes in the background. The picker updates without losing checked items or focus; newly discovered skills appear unchecked. Removed selections are reported.

Selecting skills always resolves the latest commit for the requested ref again before downloading. The discovery cache never replaces the committed lock or supplies an old download as the latest version. Non-interactive flags (`--all`, `--skill`) wait for fresh discovery. Malformed cache files are ignored, cache write failures do not block discovery, and the directory can be deleted at any time. A failed refresh leaves cached choices visible, but installing still requires successful GitHub access.

Repositories with multiple nested skill directories show a labeled section for each containing folder, separated by a blank line. For example, `cursor-team-kit/skills/deslop` appears under `cursor-team-kit`, and `third_party/github/skills/query` appears under `third_party/github`. Full folder labels distinguish similarly named plugins. Background refresh keeps skills grouped and preserves the focused skill.
