import { mkdir, readlink, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { exists } from './store.js';

export class Soul {
  constructor(root, targets = [
    join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'AGENTS.md'),
    join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'CLAUDE.md'),
  ]) {
    this.path = join(resolve(root), 'SOUL.md');
    this.targets = targets;
  }

  async ensure() {
    await mkdir(dirname(this.path), { recursive: true });
    try {
      await writeFile(this.path, '# Soul\n\nShared instructions for my coding agents.\n', { flag: 'wx' });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    if (!(await exists(this.path))?.isFile()) throw new Error(`Soul must be a regular file: ${this.path}`);
    return this.path;
  }

  async checkLinks() {
    for (const target of this.targets) {
      const stat = await exists(target);
      if (stat && (!stat.isSymbolicLink() || resolve(dirname(target), await readlink(target)) !== this.path)) {
        throw new Error(`Link conflict: ${target}. Move the existing file or link aside before running benbot install.`);
      }
    }
  }

  async install() {
    await this.checkLinks();
    await this.ensure();
    for (const target of this.targets) {
      await mkdir(dirname(target), { recursive: true });
      if (!await exists(target)) await symlink(this.path, target, 'file');
    }
  }

  async edit(run = spawnSync) {
    const file = await this.ensure();
    const result = run('nvim', [file], { stdio: 'inherit' });
    if (result.error) throw new Error(`Could not open Neovim: ${result.error.message}`);
    if (result.signal) throw new Error(`Neovim exited on ${result.signal}.`);
    return result.status ?? 1;
  }
}
