import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { parse } from 'yaml';

export function repoName(input) {
  const repo = input.replace(/^https:\/\/github\.com\//, '').replace(/\/$/, '').replace(/\.git$/, '');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || repo.split('/').some(x => x === '.' || x === '..')) {
    throw new Error('Use owner/repo or https://github.com/owner/repo. Supply branches with --ref.');
  }
  return repo;
}

export function skillName(name) {
  if (typeof name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name === 'synced') {
    throw new Error(`Invalid skill name: ${name}. Use lowercase words separated by hyphens (except synced).`);
  }
  return name;
}

export function safePath(path) {
  if (typeof path !== 'string' || !path || path.includes('\\') || path.includes('\0') || path.split('/').some(p => !p || p === '.' || p === '..' || p.toLowerCase() === '.git')) {
    throw new Error(`Unsafe repository path: ${path}`);
  }
  return path;
}

export function metadata(content) {
  const match = content.toString('utf8').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new Error('SKILL.md needs YAML frontmatter.');
  let data;
  try { data = parse(match[1], { prettyErrors: false }); }
  catch (error) { throw new Error(`Invalid YAML frontmatter: ${error.message.split('\n')[0]}`); }
  skillName(data?.name);
  if (typeof data.description !== 'string' || !data.description.trim()) throw new Error('SKILL.md needs a description.');
  return { name: data.name, description: data.description.trim() };
}

export const blobHash = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

export class GitHub {
  constructor({ fetcher = fetch, token, signal } = {}) {
    this.signal = signal;
    this.fetcher = fetcher;
    this.token = token ?? process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
    if (token === undefined && !this.token) {
      try { this.token = execFileSync('gh', ['auth', 'token', '--hostname', 'github.com'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim(); } catch { /* Public repositories work without gh. */ }
    }
    this.cache = new Map();
  }

  async api(path) {
    if (!this.cache.has(path)) {
      this.cache.set(path, (async () => {
        const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'benbot' };
        if (this.token) headers.Authorization = `Bearer ${this.token}`;
        const timeout = AbortSignal.timeout(30000);
        const signal = this.signal ? AbortSignal.any([this.signal, timeout]) : timeout;
        const response = await this.fetcher(`https://api.github.com${path}`, { headers, signal, redirect: 'error' });
        if (!response.ok) throw Object.assign(new Error(`GitHub returned ${response.status} for ${path}. Check the repository/ref and GitHub access (gh auth login).`), { status: response.status });
        return response.json();
      })());
    }
    return this.cache.get(path);
  }

  async resolve(repo, ref) {
    repoName(repo);
    const repository = await this.api(`/repos/${repo}`);
    ref ||= repository.default_branch;
    const result = await this.api(`/repos/${repo}/commits/${encodeURIComponent(ref)}`);
    return { repo, ref, private: repository.private === true, commit: result.sha, tree: result.commit.tree.sha };
  }

  async tree(repo, sha) {
    const result = await this.api(`/repos/${repo}/git/trees/${sha}?recursive=1`);
    if (!result.truncated) return result.tree;
    // Large repositories need individual tree requests; never accept a partial listing.
    const walk = async (id, prefix = '') => {
      const part = await this.api(`/repos/${repo}/git/trees/${id}`);
      if (part.truncated) throw new Error('GitHub returned an incomplete directory listing.');
      const entries = [];
      for (const entry of part.tree) {
        const path = prefix + entry.path;
        entries.push({ ...entry, path });
        if (entry.type === 'tree') entries.push(...await walk(entry.sha, `${path}/`));
      }
      return entries;
    };
    return walk(sha);
  }

  async blob(repo, sha) {
    const result = await this.api(`/repos/${repo}/git/blobs/${sha}`);
    if (result.encoding !== 'base64') throw new Error('GitHub returned an unsupported file encoding.');
    const bytes = Buffer.from(result.content, 'base64');
    if (blobHash(bytes) !== sha) throw new Error('Downloaded file failed Git blob integrity verification.');
    if (bytes.subarray(0, 80).toString().startsWith('version https://git-lfs.github.com/spec/v1')) throw new Error('Git LFS assets are not supported yet.');
    return bytes;
  }

  async discover(repo, ref, onWarning = () => {}) {
    const source = await this.resolve(repoName(repo), ref);
    const entries = await this.tree(source.repo, source.tree);
    const skills = [];
    for (const entry of entries.filter(e => e.type === 'blob' && (e.path === 'SKILL.md' || e.path.endsWith('/SKILL.md')))) {
      safePath(entry.path);
      if (entry.mode === '120000') continue;
      const path = entry.path === 'SKILL.md' ? '' : entry.path.slice(0, -'/SKILL.md'.length);
      const content = await this.blob(source.repo, entry.sha);
      let data;
      try { data = metadata(content); }
      catch (error) {
        onWarning({ path: entry.path, message: error.message });
        continue;
      }
      const tree = path ? entries.find(e => e.path === path && e.type === 'tree')?.sha : source.tree;
      if (!tree) throw new Error(`Missing tree for ${entry.path}`);
      skills.push({ ...source, ...data, path, tree });
    }
    return skills.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
  }

  async download(entry) {
    // Confirm the locked folder belongs to the locked commit before using its tree.
    const source = await this.resolve(entry.repo, entry.commit);
    const root = await this.tree(entry.repo, source.tree);
    const tree = entry.path ? root.find(e => e.type === 'tree' && e.path === entry.path)?.sha : source.tree;
    if (source.commit !== entry.commit || tree !== entry.tree) throw new Error('Lock commit and skill tree do not match.');
    const files = await this.tree(entry.repo, tree);
    const output = [];
    const seen = new Set();
    for (const file of files) {
      safePath(file.path);
      const key = file.path.toLowerCase();
      if (seen.has(key)) throw new Error(`Case-insensitive path collision: ${file.path}`);
      seen.add(key);
      if (file.type === 'tree') continue;
      if (file.type !== 'blob' || !['100644', '100755'].includes(file.mode)) throw new Error(`Unsupported symlink or submodule: ${file.path}`);
      output.push({ path: file.path, executable: file.mode === '100755', content: await this.blob(entry.repo, file.sha) });
    }
    const main = output.find(f => f.path === 'SKILL.md');
    if (!main || metadata(main.content).name !== entry.name) throw new Error('Downloaded skill name does not match the selection.');
    return output;
  }
}
