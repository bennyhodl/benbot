# Benbot

A skill manager for keeping your coding agents in sync across machines. One Git repo holds your skills and shared instructions. Benbot downloads what you choose, pins versions in a lockfile, and symlinks everything into your agents.

## How it works

- **Write your own skills** in `skills/` and keep them in Git.
- **Add skills from GitHub** with `benbot add owner/repo`. It finds nested skills and lets you select with Space, or A for all. Only the selected folders are downloaded, with no repo clone or Git history.
- **Track versions** in `skills.lock.json`. Downloads live in gitignored `vendor/`; `install` restores the pinned versions. `check` finds upstream changes, and `update` lets you choose what to update.
- **Share through symlinks.** Skills link into `~/.agents/skills` and `~/.claude/skills`. `SOUL.md` links to `~/.agents/AGENTS.md`, `~/.codex/AGENTS.md`, and `~/.claude/CLAUDE.md` for shared global instructions.

Commit your own skills, instructions, and lockfile. On another machine, pull the repo and run `benbot install`.

## Install

Requires Node.js 20+ and pnpm.

```sh
git clone https://github.com/bennyhodl/benbot.git ~/Development/benbot
cd ~/Development/benbot/lib
pnpm install --frozen-lockfile
pnpm link --global
benbot install --root ~/Development/benbot
```

The repo path is saved, so commands work from anywhere. To use a different location, run `benbot install --root /path/to/repo`.

Private sources are marked in the lockfile. Use `gh auth login` for access; install skips inaccessible private sources with a notice.

## Use

```sh
benbot                          # Open the menu
benbot add owner/repo            # Select skills to download
benbot new my-skill              # Create and link a skill
benbot link /path/to/skill       # Use a skill from a local checkout
benbot list                     # Show skills and descriptions
benbot check                    # Check for updates
benbot update                   # Select updates to apply
benbot install                  # Restore downloads and create links
benbot soul                     # Edit shared instructions in Neovim
benbot remove my-skill           # Delete a skill and its managed links
```

Removing a linked checkout keeps its source files. Run `benbot --help` for options.
