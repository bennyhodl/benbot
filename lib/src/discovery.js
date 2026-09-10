import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { skillOptions, skillPicker } from './picker.js';
import { writeJson } from './store.js';

export class DiscoveryCache {
  constructor(root) { this.dir = join(root, '.benbot-cache', 'repos'); }
  file(repo, ref) {
    const key = createHash('sha256').update(JSON.stringify([repo.toLowerCase(), ref || null])).digest('hex');
    return join(this.dir, `${key}.json`);
  }
  async load(repo, ref) {
    try {
      const cached = JSON.parse(await readFile(this.file(repo, ref), 'utf8'));
      if (cached.version !== 1 || !Array.isArray(cached.skills) || !cached.skills.every(s =>
        typeof s.name === 'string' && typeof s.path === 'string' && typeof s.description === 'string')) return null;
      return cached.skills;
    } catch { return null; } // A cache is disposable; invalid or missing entries get fetched again.
  }
  async refresh(github, repo, ref) {
    const warnings = [];
    try {
      const skills = await github.discover(repo, ref, warning => warnings.push(warning));
      try {
        await writeJson(this.file(repo, ref), { version: 1, repo, ref: ref || null, fetchedAt: new Date().toISOString(), skills });
      } catch { warnings.push({ path: 'discovery cache', message: 'Could not save results; discovery still succeeded.' }); }
      return { skills, warnings };
    } catch (error) { return { error, warnings }; }
  }
}

const option = skill => skillOptions([skill])[0];

// Keep the same array and row positions: Clack retains its cursor and checked
// values. Add new rows at the end and visibly disable skills removed upstream.
export function updateChoices(options, skills) {
  const remaining = new Map(skills.map(skill => [skill.path, skill]));
  for (const item of options) {
    const skill = remaining.get(item.value);
    if (skill) {
      Object.assign(item, option(skill));
      remaining.delete(item.value);
    } else {
      item.disabled = true;
      item.hint = 'No longer available upstream';
    }
  }
  options.push(...[...remaining.values()].map(option));
}

export async function chooseCached(skills, refresh, output = process.stdout) {
  let available = skills;
  let suffix = ' (refreshing…)';
  let active = true;
  const options = skillOptions(skills);
  const selection = skillPicker({
    message: () => `Which skills would you like to add?${suffix}`,
    options,
    output,
  });
  const updated = refresh.then(result => {
    if (!active) return;
    if (result.error) suffix = ' (cached; refresh failed)';
    else {
      available = result.skills;
      updateChoices(options, available);
      suffix = '';
    }
    // Request Clack's standard redraw without restarting the selection prompt.
    selection.refresh();
  });
  try {
    const values = await selection;
    if (typeof values === 'symbol') return values;
    return values.map(path => {
      const skill = available.find(s => s.path === path);
      if (!skill) throw new Error(`Selected skill at ${path || '(repo root)'} is no longer available. Run benbot add again.`);
      return skill;
    });
  } finally {
    active = false;
    void updated.catch(() => {});
  }
}

export async function latestSelected(github, repo, ref, selected) {
  const source = await github.resolve(repo, ref);
  const entries = await github.tree(repo, source.tree);
  return selected.map(skill => {
    const tree = skill.path ? entries.find(e => e.type === 'tree' && e.path === skill.path)?.sha : source.tree;
    if (!tree) throw new Error(`${skill.name} is no longer at ${skill.path || '(repo root)'}. Run benbot add again to refresh your selection.`);
    return { ...skill, ...source, tree };
  });
}
