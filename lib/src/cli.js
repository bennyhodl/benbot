#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import * as p from '@clack/prompts';
import { GitHub, repoName, metadata } from './github.js';
import { Store, configPath, writeJson, rootPath, exists } from './store.js';
import { Soul } from './soul.js';
import { skillOptions, skillPicker } from './picker.js';
import { DiscoveryCache, chooseCached, latestSelected } from './discovery.js';

const HELP = `benbot — your skills, on every machine

  benbot help                         Show this help
  benbot add owner/repo               Discover and select GitHub skills
  benbot install                     Install skills and shared global instructions
  benbot soul                        Edit shared instructions in Neovim
  benbot list                        List personal and downloaded skills
  benbot check [name]                 Check upstream for skill changes
  benbot update [name]                Select and apply available updates
  benbot remove [name]                Remove a skill
  benbot new [name]                   Create a personal skill
  benbot link <skill-folder>          Link a local checkout's skill

Options:
  --root <path>                       Choose the repo; install remembers it
  --ref <branch|tag|sha>              GitHub ref to follow when adding
  --skill <name>                      Select a skill (repeatable)
  --all                              Select every discovered/changed skill
  --description <text>                Description for a new skill
  -y, --yes                          Skip removal confirmation
  -h, --help                         Show this help
  --version                          Show CLI version

Default repo: ~/Development/benbot. BENBOT_HOME overrides saved configuration.
Global commands never depend on your current directory (except explicit paths).
`;

class Cancelled extends Error {}
const interactive = () => !!process.stdin.isTTY;
async function answer(promise) {
  const value = await promise;
  if (p.isCancel(value)) throw new Cancelled();
  return value;
}
async function input(message, value, defaultValue) {
  if (value) return value;
  if (!interactive()) throw new Error(`${message} Supply the argument in non-interactive mode.`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise((resolve, reject) => {
      rl.once('SIGINT', () => reject(new Cancelled()));
      rl.once('close', () => reject(new Cancelled()));
      const ask = () => rl.question(`${message} `, value => {
        if (value.trim() || defaultValue !== undefined) resolve(value.trim() || defaultValue);
        else ask();
      });
      ask();
    });
  } finally { rl.close(); }
}
async function working(message, task) {
  console.log(`${message}...`);
  return task();
}
async function choose(skills, flags, message) {
  if (!skills.length) return [];
  if (flags.all) return skills;
  if (flags.skill?.length) {
    return flags.skill.map(name => {
      const matches = skills.filter(s => s.name === name || `${s.name}:${s.path}` === name);
      if (matches.length !== 1) throw new Error(`Skill ${name} is missing or ambiguous. Use name:folder-path when names repeat.`);
      return matches[0];
    });
  }
  if (skills.length === 1) return skills;
  if (!interactive()) throw new Error('Use --skill <name> or --all to select skills without an interactive terminal.');
  const paths = await answer(skillPicker({ options: skillOptions(skills), message: () => message }));
  return paths.map(path => skills.find(skill => skill.path === path));
}

async function changes(store, github, name) {
  const lock = await store.lock();
  if (name && !lock.skills[name]) throw new Error(`Unknown downloaded skill: ${name}`);
  const result = [];
  for (const [key, entry] of Object.entries(lock.skills)) {
    if (name && name !== key) continue;
    await store.unmodified(key, entry);
    const upstream = await github.resolve(entry.repo, entry.ref);
    const entries = await github.tree(entry.repo, upstream.tree);
    const tree = entry.path ? entries.find(e => e.type === 'tree' && e.path === entry.path)?.sha : upstream.tree;
    if (!tree) throw new Error(`${key}: upstream folder ${entry.path} no longer exists. The installed version was kept.`);
    if (tree !== entry.tree) result.push({ ...entry, name: key, private: upstream.private, commit: upstream.commit, tree });
  }
  return { lock, result };
}

async function main() {
  const { values: flags, positionals } = parseArgs({ allowPositionals: true, options: {
    root: { type: 'string' }, ref: { type: 'string' }, skill: { type: 'string', multiple: true }, all: { type: 'boolean' },
    description: { type: 'string' }, yes: { type: 'boolean', short: 'y' }, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean' },
  } });
  if (flags.help || positionals[0] === 'help') { console.log(HELP); return; }
  if (flags.version) { console.log('0.1.0'); return; }
  let [command, argument] = positionals;
  if (positionals.length > 2) throw new Error('Too many arguments. See benbot --help.');
  if (!command && !interactive()) { console.log(HELP); return; }
  if (!command) command = await answer(p.select({ message: 'What would you like to do?', options: [
    ['add', 'Add skills from GitHub'], ['install', 'Install and link skills'], ['check', 'Check for updates'], ['update', 'Update skills'],
    ['soul', 'Edit shared instructions'], ['list', 'List skills'], ['new', 'Create a skill'], ['remove', 'Remove a skill'], ['link', 'Link a local skill'],
  ].map(([value, label]) => ({ value, label })) }));
  if (!['add', 'install', 'list', 'check', 'update', 'remove', 'new', 'link', 'soul'].includes(command)) throw new Error(`Unknown command: ${command}. See benbot --help.`);
  const root = await rootPath(flags.root);
  const store = new Store(root);
  const soul = new Soul(root);
  if (!await exists(store.lockPath)) throw new Error(`No Benbot lock in ${root}. Clone your skills repo there, or use --root /path/to/skills.`);
  if (command === 'soul') {
    process.exitCode = await soul.edit();
    return;
  }
  if (command === 'list') {
    const lock = await store.lock();
    const all = await store.selections(lock);
    const width = Math.max(20, Math.min(process.stdout.columns || 96, 96) - 2);
    const blocks = [];
    for (const [name, path] of [...all].sort(([a], [b]) => a.localeCompare(b))) {
      const description = await exists(join(path, 'SKILL.md'))
        ? metadata(await readFile(join(path, 'SKILL.md'))).description
        : `Not installed${lock.skills[name]?.private ? ' (private repository)' : ''}. Run benbot install.`;
      const lines = [];
      let line = '';
      for (const word of description.split(/\s+/)) {
        if (line && line.length + word.length + 1 > width) {
          lines.push(`  ${line}`);
          line = word;
        } else {
          line += `${line ? ' ' : ''}${word}`;
        }
      }
      if (line) lines.push(`  ${line}`);
      const source = lock.skills[name]?.repo;
      const title = process.stdout.isTTY ? `\x1b[4m${name}\x1b[24m` : name;
      blocks.push([source ? `${title}  ${source}` : title, ...lines].join('\n'));
    }
    console.log(blocks.length ? `\n${blocks.join('\n\n')}\n` : 'No skills installed yet.');
    return;
  }
  await store.exclusive(async () => {
    if (command === 'new') {
      const name = await input('Skill name?', argument);
      const description = await input('When should this skill be used?', flags.description);
      console.log(`Created and linked ${await store.create(name, description)}`); return;
    }
    if (command === 'link') {
      const path = await input('Path to the folder containing SKILL.md?', argument);
      console.log(`Linked ${await store.localLink(path)}. Checkout path saved in benbot.local.json.`); return;
    }
    if (command === 'remove') {
      const removable = await store.removable();
      const names = [...removable.keys()].sort();
      if (!names.length && !argument) { console.log('No skills to remove.'); return; }
      const name = argument || (names.length === 1 ? names[0] : undefined) || (interactive() ? await answer(p.select({ message: 'Remove which skill?', options: names.map(value => ({ value, label: value })) })) : undefined);
      if (!name) throw new Error('Supply a skill name and --yes in non-interactive mode.');
      const selected = removable.get(name);
      if (!selected) throw new Error(`Unknown skill: ${name}. Run benbot list to see your skills.`);
      const action = ['linked', 'symlink'].includes(selected.kind) ? `Unlink ${name} (keep its source files)?` : `Delete ${name} and its managed links?`;
      if (!flags.yes) {
        if (!interactive()) throw new Error('Use --yes to confirm removal.');
        if (!/^y(es)?$/i.test(await input(`${action} [y/N]`, undefined, 'n'))) { console.log('Kept skill.'); return; }
      }
      await store.remove(name); console.log(`Removed ${name}.`); return;
    }
    const github = new GitHub();
    if (command === 'install') {
      await soul.checkLinks();
      const count = await store.install(github, message => console.error(message));
      await soul.install();
      await writeJson(configPath(), { root });
      console.log(`Installed ${count} skills and linked SOUL.md as AGENTS.md and CLAUDE.md.`); return;
    }
    if (command === 'add') {
      const repo = repoName(await input('GitHub repository (owner/repo)?', argument));
      const cache = new DiscoveryCache(root);
      const cached = await cache.load(repo, flags.ref);
      const refreshController = new AbortController();
      const refresh = cache.refresh(new GitHub({ signal: refreshController.signal }), repo, flags.ref);
      let selected;
      if (cached?.length && interactive() && !flags.all && !flags.skill?.length) {
        try { selected = await answer(chooseCached(cached, refresh)); }
        catch (error) { refreshController.abort(); throw error; }
      } else {
        const result = await working(`Discovering skills in ${repo}`, () => refresh);
        if (result.error) throw result.error;
        selected = await choose(result.skills, flags, 'Which skills would you like to add?');
      }
      const refreshed = await refresh;
      for (const warning of refreshed.warnings) console.error(`Skipped ${warning.path}: ${warning.message}`);
      if (refreshed.error) console.error(`Refresh failed: ${refreshed.error.message}`);
      if (selected.length) {
        // Resolve the ref again after selection. A cached discovery commit is never installed.
        selected = await working('Resolving selected skills at the latest revision', () => latestSelected(new GitHub(), repo, flags.ref, selected));
      }
      if (!selected.length) { console.log('No valid skills found in this repository.'); return; }
      const names = new Set();
      const lock = await store.lock();
      const all = await store.selections(lock);
      for (const entry of selected) {
        if (names.has(entry.name) || all.has(entry.name)) throw new Error(`Skill ${entry.name} already exists or is selected twice. Use update for an installed skill.`);
        names.add(entry.name); all.set(entry.name, store.destination(entry.name));
      }
      await store.checkLinks(all);
      for (const entry of selected) await working(`Installing ${entry.name}`, async () => {
        await store.put(entry.name, entry, await github.download(entry), lock);
      });
      console.log(`Added ${selected.length} skills. Commit skills.lock.json to share them.`); return;
    }
    const { lock, result } = await working('Checking upstream skill folders', () => changes(store, github, argument));
    if (!result.length) { console.log('All tracked skill folders are up to date.'); return; }
    if (command === 'check') {
      for (const entry of result) console.log(`${entry.name}  ${lock.skills[entry.name].commit.slice(0, 12)} → ${entry.commit.slice(0, 12)}`);
      console.log(`${result.length} updates available. Run benbot update.`); return;
    }
    const selected = argument ? result : await choose(result, flags, 'Which skills would you like to update?');
    for (const entry of selected) await working(`Updating ${entry.name}`, async () => {
      await store.put(entry.name, entry, await github.download(entry), lock);
    });
    console.log(`Updated ${selected.length} skills. Review the diff in ${root}.`);
  });
}
main().catch(error => {
  if (error instanceof Cancelled) { console.log('Cancelled.'); return; }
  console.error(`Error: ${error.message}`); process.exitCode = 1;
});
