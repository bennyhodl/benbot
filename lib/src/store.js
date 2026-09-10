import * as fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { skillName, safePath, repoName, metadata } from './github.js';

export const defaultRoot = () => join(homedir(), 'Development', 'benbot');
export const configPath = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'benbot', 'config.json');
export async function exists(path) {
  try { return await fs.lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export async function json(path, fallback) {
  try { return JSON.parse(await fs.readFile(path, 'utf8')); } catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return fallback; throw new Error(`Cannot read ${path}: ${error.message}`); }
}
export async function writeJson(path, data) {
  await fs.mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temp, `${JSON.stringify(data, null, 2)}\n`); await fs.rename(temp, path); }
  finally { await fs.rm(temp, { force: true }); }
}
export async function rootPath(override) {
  const config = override || process.env.BENBOT_HOME ? {} : await json(configPath(), {});
  return resolve(override || process.env.BENBOT_HOME || config.root || defaultRoot());
}
export async function contents(path) {
  const result = [];
  async function walk(dir, prefix = '') {
    for (const item of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = prefix + item.name;
      if (item.isSymbolicLink()) throw new Error(`Unexpected symlink inside skill: ${file}`);
      if (item.isDirectory()) await walk(join(dir, item.name), `${file}/`);
      else if (item.isFile()) {
        const full = join(dir, item.name);
        result.push({ path: file, executable: !!((await fs.stat(full)).mode & 0o111), content: await fs.readFile(full) });
      } else throw new Error(`Unsupported file: ${file}`);
    }
  }
  await walk(path);
  return result;
}
export function digest(files) {
  const hash = createHash('sha256');
  for (const file of [...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
    hash.update(JSON.stringify([file.path, file.executable, file.content.length]));
    hash.update(file.content);
  }
  return hash.digest('hex');
}

export class Store {
  constructor(root, targets = [join(homedir(), '.agents', 'skills'), join(homedir(), '.claude', 'skills')]) {
    this.root = resolve(root);
    this.targets = targets;
    this.lockPath = join(this.root, 'skills.lock.json');
  }
  async lock() {
    const lock = await json(this.lockPath);
    if (lock.version !== 1 || !lock.skills || typeof lock.skills !== 'object' || Array.isArray(lock.skills)) throw new Error('Unsupported skills.lock.json.');
    for (const [name, entry] of Object.entries(lock.skills)) {
      skillName(name); repoName(entry.repo);
      if (entry.private !== undefined && typeof entry.private !== 'boolean') throw new Error(`Invalid private flag: ${name}`);
      if (entry.path !== '') safePath(entry.path);
      if (![entry.commit, entry.tree].every(s => typeof s === 'string' && /^[a-f0-9]{40}$/.test(s)) || !/^[a-f0-9]{64}$/.test(entry.digest) || typeof entry.ref !== 'string' || !entry.ref) throw new Error(`Invalid lock entry: ${name}`);
    }
    return lock;
  }
  async save(lock) {
    await writeJson(this.lockPath, { ...lock, skills: Object.fromEntries(Object.entries(lock.skills).sort(([a], [b]) => a.localeCompare(b))) });
  }
  async exclusive(work) {
    const busy = join(this.root, '.benbot-busy');
    await fs.mkdir(this.root, { recursive: true });
    try { await fs.mkdir(busy); } catch (error) {
      if (error.code === 'EEXIST') throw new Error(`Another Benbot command is running. If it crashed, remove ${busy} before retrying.`);
      throw error;
    }
    try { return await work(); } finally { await fs.rmdir(busy); }
  }
  destination(name) { return join(this.root, 'vendor', skillName(name)); }
  async unmodified(name, entry) {
    const path = this.destination(name);
    const stat = await exists(path);
    if (!stat) return false;
    if (!stat.isDirectory() || digest(await contents(path)) !== entry.digest) throw new Error(`${name} has local edits or unexpected files. Preserve them in a personal skill or fork before updating/removing it.`);
    return true;
  }
  async personal() {
    const dir = join(this.root, 'skills');
    const found = new Map();
    if (!await exists(dir)) return found;
    for (const item of await fs.readdir(dir)) {
      if (item.startsWith('.')) continue;
      const path = join(dir, item);
      if (!await exists(join(path, 'SKILL.md'))) continue;
      const data = metadata(await fs.readFile(join(path, 'SKILL.md')));
      if (data.name !== item) throw new Error(`Personal folder ${item} must match SKILL.md name ${data.name}.`);
      found.set(item, path);
    }
    const local = await json(join(this.root, 'benbot.local.json'), { links: {} });
    for (const [name, path] of Object.entries(local.links || {})) {
      skillName(name);
      if (found.has(name)) throw new Error(`Duplicate personal/local skill: ${name}`);
      const data = metadata(await fs.readFile(join(path, 'SKILL.md')));
      if (data.name !== name) throw new Error(`Local skill name changed: ${name}`);
      found.set(name, resolve(path));
    }
    return found;
  }
  async selections(lock) {
    const all = await this.personal();
    for (const name of Object.keys(lock.skills)) {
      if (all.has(name)) throw new Error(`Personal and downloaded skills share the name ${name}. Rename one.`);
      all.set(name, this.destination(name));
    }
    return all;
  }
  async checkLinks(all) {
    for (const [name, source] of all) {
      for (const target of this.targets) {
        const link = join(target, name);
        const stat = await exists(link);
        if (stat && (!stat.isSymbolicLink() || resolve(dirname(link), await fs.readlink(link)) !== resolve(source))) {
          throw new Error(`Link conflict: ${link}. Benbot will not replace an existing file or another tool's link.`);
        }
      }
    }
  }
  async linkAll(all) {
    await this.checkLinks(all);
    for (const [name, source] of all) {
      if (!await exists(source)) continue;
      for (const target of this.targets) {
        await fs.mkdir(target, { recursive: true });
        const link = join(target, name);
        if (!await exists(link)) await fs.symlink(source, link, 'dir');
      }
    }
  }
  async unlink(name, source) {
    for (const target of this.targets) {
      const link = join(target, name);
      if ((await exists(link))?.isSymbolicLink() && resolve(dirname(link), await fs.readlink(link)) === resolve(source)) await fs.unlink(link);
    }
  }
  async put(name, entry, files, lock) {
    skillName(name);
    const dest = this.destination(name);
    if (lock.skills[name]) await this.unmodified(name, lock.skills[name]);
    else if (await exists(dest)) throw new Error(`Untracked directory already exists: ${dest}`);
    const next = { repo: entry.repo, path: entry.path, ref: entry.ref, commit: entry.commit, tree: entry.tree, digest: digest(files) };
    if (entry.private !== undefined) next.private = entry.private;
    const all = await this.selections({ version: 1, skills: { ...lock.skills, [name]: next } });
    await this.checkLinks(all);
    const stage = await fs.mkdtemp(join(this.root, '.benbot-stage-'));
    const payload = join(stage, 'payload');
    const backup = join(stage, 'backup');
    const old = lock.skills[name];
    let backedUp = false;
    let installed = false;
    try {
      await fs.mkdir(payload);
      for (const file of files) {
        const out = join(payload, safePath(file.path));
        await fs.mkdir(dirname(out), { recursive: true });
        await fs.writeFile(out, file.content, { mode: file.executable ? 0o755 : 0o644 });
        await fs.chmod(out, file.executable ? 0o755 : 0o644);
      }
      await fs.mkdir(dirname(dest), { recursive: true });
      if (await exists(dest)) { await fs.rename(dest, backup); backedUp = true; }
      await fs.rename(payload, dest); installed = true;
      lock.skills[name] = next;
      await this.save(lock);
    } catch (error) {
      if (installed) await fs.rm(dest, { recursive: true });
      if (backedUp) await fs.rename(backup, dest);
      if (old) lock.skills[name] = old; else delete lock.skills[name];
      throw error;
    } finally { await fs.rm(stage, { recursive: true, force: true }); }
    await this.linkAll(all);
  }
  async install(github, onWarning = () => {}) {
    const lock = await this.lock();
    const all = await this.selections(lock);
    await this.checkLinks(all);
    const inaccessible = new Set();
    for (const [name, entry] of Object.entries(lock.skills)) {
      if (!await this.unmodified(name, entry)) {
        if (entry.private) {
          if (!inaccessible.has(entry.repo)) {
            try { await github.api(`/repos/${entry.repo}`); }
            catch (error) {
              if (![401, 403, 404].includes(error.status)) throw error;
              inaccessible.add(entry.repo);
              onWarning(`Skipped private repository ${entry.repo}: GitHub access unavailable (HTTP ${error.status}). Run gh auth login with an account that has access, then retry benbot install.`);
            }
          }
          if (inaccessible.has(entry.repo)) {
            all.delete(name);
            await this.unlink(name, this.destination(name));
            continue;
          }
        }
        const files = await github.download({ ...entry, name });
        if (digest(files) !== entry.digest) throw new Error(`Downloaded contents do not match the lock for ${name}.`);
        await this.put(name, entry, files, lock);
      }
    }
    await this.linkAll(all);
    return all.size;
  }
  async removable() {
    const found = new Map();
    const add = (name, kind, path) => {
      skillName(name);
      if (found.has(name)) throw new Error(`Multiple sources use the name ${name}. Resolve the duplicate before removing it.`);
      found.set(name, { kind, path });
    };
    for (const name of Object.keys((await this.lock()).skills)) add(name, 'vendored', this.destination(name));
    const dir = join(this.root, 'skills');
    if (await exists(dir)) {
      for (const item of await fs.readdir(dir, { withFileTypes: true })) {
        if (item.name.startsWith('.')) continue;
        if (item.isDirectory() || item.isSymbolicLink()) add(item.name, item.isSymbolicLink() ? 'symlink' : 'personal', join(dir, item.name));
      }
    }
    const local = await json(join(this.root, 'benbot.local.json'), { links: {} });
    for (const [name, path] of Object.entries(local.links || {})) add(name, 'linked', resolve(path));
    return found;
  }
  async remove(name) {
    skillName(name);
    const selected = (await this.removable()).get(name);
    if (!selected) throw new Error(`Unknown skill: ${name}. Run benbot list to see your skills.`);
    if (selected.kind === 'vendored') {
      const lock = await this.lock();
      await this.unmodified(name, lock.skills[name]);
      delete lock.skills[name];
      await this.save(lock);
    } else if (selected.kind === 'linked') {
      const file = join(this.root, 'benbot.local.json');
      const local = await json(file);
      delete local.links[name];
      await writeJson(file, local);
    }
    await this.unlink(name, selected.path);
    // A local checkout belongs to its own repo. Only unregister it and its links.
    if (selected.kind !== 'linked') await fs.rm(selected.path, { recursive: true, force: true });
  }
  async create(name, description) {
    skillName(name);
    const lock = await this.lock();
    const all = await this.selections(lock);
    if (all.has(name)) throw new Error(`Skill already exists: ${name}`);
    const path = join(this.root, 'skills', name);
    if (await exists(path)) throw new Error(`Directory already exists: ${path}`);
    all.set(name, path);
    await this.checkLinks(all);
    await fs.mkdir(path, { recursive: true });
    await fs.writeFile(join(path, 'SKILL.md'), `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n# ${name}\n\nDescribe the workflow here.\n`);
    await this.linkAll(all);
    return path;
  }
  async localLink(path) {
    path = await fs.realpath(resolve(path));
    const { name } = metadata(await fs.readFile(join(path, 'SKILL.md')));
    const all = await this.selections(await this.lock());
    if (all.has(name)) throw new Error(`Skill already exists: ${name}`);
    all.set(name, path);
    await this.checkLinks(all);
    const file = join(this.root, 'benbot.local.json');
    const local = await json(file, { links: {} });
    local.links ||= {};
    local.links[name] = path;
    await writeJson(file, local);
    await this.linkAll(all);
    return name;
  }
}
