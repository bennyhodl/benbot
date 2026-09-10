import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { Store, digest, contents, exists } from '../src/store.js';
import { GitHub, blobHash, safePath, metadata } from '../src/github.js';

const skill = Buffer.from('---\nname: example\ndescription: Use for testing.\n---\n\nTest skill.\n');
const files = [{ path: 'SKILL.md', executable: false, content: skill }, { path: 'scripts/run.sh', executable: true, content: Buffer.from('#!/bin/sh\ntrue\n') }, { path: 'assets/binary', executable: false, content: Buffer.from([0, 255, 10]) }];
const entry = { name: 'example', repo: 'owner/repo', path: 'skills/example', ref: 'main', commit: 'a'.repeat(40), tree: 'b'.repeat(40) };
async function fixture(t) {
  const dir = await fs.mkdtemp(join(tmpdir(), 'benbot-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, 'repo'), [join(dir, '.agents/skills'), join(dir, '.claude/skills')]);
  await fs.mkdir(join(store.root, 'skills'), { recursive: true });
  await fs.mkdir(join(store.root, 'vendor'), { recursive: true });
  await store.save({ version: 1, skills: {} });
  return { dir, store };
}

test('install restores exact revisions, files and executable modes into both agents', async t => {
  const { store } = await fixture(t);
  const lock = await store.lock();
  await store.put('example', entry, files, lock);
  assert.equal(digest(await contents(store.destination('example'))), digest(files));
  for (const target of store.targets) assert.equal(await fs.readlink(join(target, 'example')), store.destination('example'));
  await fs.rm(store.destination('example'), { recursive: true });
  const before = await fs.readFile(store.lockPath, 'utf8');
  let received;
  await store.install({ download: async e => { received = e; return files; } });
  assert.equal(received.commit, entry.commit);
  assert.equal(await fs.readFile(store.lockPath, 'utf8'), before);
  assert.deepEqual(await fs.readFile(join(store.destination('example'), 'assets/binary')), files[2].content);
  await store.install({ download: () => assert.fail('Existing vendor files should install offline') });
});

test('local edits stop update, remove and install without changing the lock', async t => {
  const { store } = await fixture(t);
  const lock = await store.lock();
  await store.put('example', entry, files, lock);
  await fs.appendFile(join(store.destination('example'), 'SKILL.md'), 'local edit');
  const before = await fs.readFile(store.lockPath, 'utf8');
  await assert.rejects(store.put('example', entry, files, lock), /local edits/);
  await assert.rejects(store.remove('example'), /local edits/);
  await assert.rejects(store.install({}), /local edits/);
  assert.equal(await fs.readFile(store.lockPath, 'utf8'), before);
});

test('conflicting agent files are preserved before any vendor/lock changes', async t => {
  const { store } = await fixture(t);
  await fs.mkdir(store.targets[1], { recursive: true });
  const conflict = join(store.targets[1], 'example');
  await fs.writeFile(conflict, 'keep');
  await assert.rejects(store.put('example', entry, files, await store.lock()), /Link conflict/);
  assert.equal(await fs.readFile(conflict, 'utf8'), 'keep');
  assert.equal(await exists(store.destination('example')), null);
  assert.deepEqual((await store.lock()).skills, {});
});

test('failed lock write restores the old download', async t => {
  const { store } = await fixture(t);
  const lock = await store.lock();
  await store.put('example', entry, files, lock);
  store.save = async () => { throw new Error('disk full'); };
  await assert.rejects(store.put('example', { ...entry, commit: 'c'.repeat(40) }, [...files, { path: 'new', executable: false, content: Buffer.from('new') }], lock), /disk full/);
  assert.equal(digest(await contents(store.destination('example'))), digest(files));
  assert.equal(lock.skills.example.commit, entry.commit);
});

test('remove only removes links pointing at this managed download', async t => {
  const { store, dir } = await fixture(t);
  await store.put('example', entry, files, await store.lock());
  const link = join(store.targets[0], 'example');
  await fs.unlink(link);
  await fs.symlink(join(dir, 'someone-else'), link);
  await store.remove('example');
  assert.equal(await fs.readlink(link), join(dir, 'someone-else'));
  assert.equal(await exists(join(store.targets[1], 'example')), null);
});

test('personal skills and local checkouts link without being downloaded', async t => {
  const { store, dir } = await fixture(t);
  await store.create('personal', 'Use for a personal workflow.');
  const checkout = join(dir, 'checkout');
  await fs.mkdir(checkout);
  await fs.writeFile(join(checkout, 'SKILL.md'), skill);
  await store.localLink(checkout);
  assert.equal(await store.install({ download: () => assert.fail('No remote dependencies') }), 2);
  assert.equal(await fs.readlink(join(store.targets[0], 'example')), await fs.realpath(checkout));
});

test('path traversal, unsafe names, and corrupt locks are rejected', async t => {
  const { store } = await fixture(t);
  for (const path of ['../x', '/x', 'a/../x', 'a\\x', '.git/config']) assert.throws(() => safePath(path), /Unsafe/);
  assert.throws(() => metadata(Buffer.from('---\nname: ../bad\ndescription: bad\n---\n')), /Invalid skill/);
  await fs.writeFile(store.lockPath, '{bad');
  await assert.rejects(store.lock(), /Cannot read/);
});

test('concurrent mutations refuse to run and release the mutex after errors', async t => {
  const { store } = await fixture(t);
  await store.exclusive(async () => {
    await assert.rejects(store.exclusive(() => {}), /Another Benbot/);
  });
  await assert.rejects(store.exclusive(() => { throw new Error('failure'); }), /failure/);
  await store.exclusive(() => {});
});

test('GitHub discovery pins commit, downloads binary blobs, verifies integrity', async () => {
  const sha = blobHash(skill);
  const seen = [];
  const routes = {
    '/repos/owner/repo': { default_branch: 'main' },
    '/repos/owner/repo/commits/main': { sha: entry.commit, commit: { tree: { sha: 'c'.repeat(40) } } },
    [`/repos/owner/repo/commits/${entry.commit}`]: { sha: entry.commit, commit: { tree: { sha: 'c'.repeat(40) } } },
    [`/repos/owner/repo/git/trees/${'c'.repeat(40)}?recursive=1`]: { tree: [{ path: entry.path, type: 'tree', sha: entry.tree }, { path: `${entry.path}/SKILL.md`, type: 'blob', mode: '100644', sha }], truncated: false },
    [`/repos/owner/repo/git/trees/${entry.tree}?recursive=1`]: { tree: [{ path: 'SKILL.md', type: 'blob', mode: '100644', sha }], truncated: false },
    [`/repos/owner/repo/git/blobs/${sha}`]: { encoding: 'base64', content: skill.toString('base64') },
  };
  const github = new GitHub({ token: '', fetcher: async url => {
    const path = url.replace('https://api.github.com', ''); seen.push(path);
    assert.ok(routes[path], path);
    return { ok: true, json: async () => routes[path] };
  } });
  const [found] = await github.discover('owner/repo');
  assert.equal(found.commit, entry.commit);
  assert.equal(found.name, 'example');
  assert.deepEqual((await github.download(found))[0].content, skill);
  assert.ok(seen.every(path => !path.includes('archive')));
  const broken = new GitHub({ token: '', fetcher: async () => ({ ok: true, json: async () => ({ encoding: 'base64', content: Buffer.from('bad').toString('base64') }) }) });
  await assert.rejects(broken.blob('owner/repo', sha), /integrity/);
});

test('truncated GitHub trees fall back to complete subtree listings', async () => {
  const github = new GitHub({ token: '', fetcher: async url => ({ ok: true, json: async () => {
    if (url.includes('?recursive=')) return { truncated: true, tree: [] };
    if (url.endsWith('/root')) return { tree: [{ path: 'sub', type: 'tree', sha: 'child' }] };
    return { tree: [{ path: 'SKILL.md', type: 'blob', sha: 'blob' }] };
  } }) });
  assert.deepEqual((await github.tree('owner/repo', 'root')).map(e => e.path), ['sub', 'sub/SKILL.md']);
});

test('CLI remembers install location and works from an unrelated directory', async t => {
  const { dir, store } = await fixture(t);
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const env = { ...process.env, XDG_CONFIG_HOME: join(dir, 'config'), CODEX_HOME: join(dir, 'codex'), CLAUDE_CONFIG_DIR: join(dir, 'claude'), NO_COLOR: '1' };
  delete env.BENBOT_HOME;
  execFileSync(process.execPath, [cli, 'install', '--root', store.root], { cwd: tmpdir(), env });
  await store.create('remembered', 'A skill from the configured repository.');
  const output = execFileSync(process.execPath, [cli, 'list'], { cwd: tmpdir(), env, encoding: 'utf8' });
  assert.match(output, /remembered\n  A skill from the configured repository\./);
  assert.ok(!output.includes(store.root));
});

test('install rejects downloads that differ from the committed lock', async t => {
  const { store } = await fixture(t);
  await store.put('example', entry, files, await store.lock());
  await fs.rm(store.destination('example'), { recursive: true });
  const before = await fs.readFile(store.lockPath, 'utf8');
  await assert.rejects(store.install({ download: async () => [files[0]] }), /do not match the lock/);
  assert.equal(await exists(store.destination('example')), null);
  assert.equal(await fs.readFile(store.lockPath, 'utf8'), before);
});

test('GitHub downloads reject symlinks and mismatched locked trees', async () => {
  const github = new GitHub({ token: '' });
  github.resolve = async () => ({ commit: entry.commit, tree: 'root' });
  github.tree = async (_repo, tree) => tree === 'root'
    ? [{ path: entry.path, type: 'tree', sha: entry.tree }]
    : [{ path: 'external', type: 'blob', mode: '120000', sha: 'x' }];
  await assert.rejects(github.download(entry), /symlink or submodule/);
  await assert.rejects(github.download({ ...entry, tree: 'c'.repeat(40) }), /do not match/);
});

test('soul installs one shared file under both global names and preserves edits', async t => {
  const { Soul } = await import('../src/soul.js');
  const { dir, store } = await fixture(t);
  const targets = [join(dir, '.codex/AGENTS.md'), join(dir, '.claude/CLAUDE.md')];
  const soul = new Soul(store.root, targets);
  await soul.install();
  for (const target of targets) assert.equal(await fs.readlink(target), soul.path);
  await fs.writeFile(soul.path, 'My shared instructions.\n');
  await soul.install();
  for (const target of targets) assert.equal(await fs.readFile(target, 'utf8'), 'My shared instructions.\n');
});

test('soul refuses conflicting files and symlinks before changing either target', async t => {
  const { Soul } = await import('../src/soul.js');
  const { dir, store } = await fixture(t);
  const targets = [join(dir, 'AGENTS.md'), join(dir, 'CLAUDE.md')];
  const soul = new Soul(store.root, targets);
  await fs.writeFile(targets[1], 'Existing rules');
  await assert.rejects(soul.install(), /Link conflict/);
  assert.equal(await exists(targets[0]), null);
  assert.equal(await fs.readFile(targets[1], 'utf8'), 'Existing rules');
  await fs.unlink(targets[1]);
  await fs.symlink(join(dir, 'another-repo'), targets[1]);
  await assert.rejects(soul.install(), /Link conflict/);
  assert.equal(await fs.readlink(targets[1]), join(dir, 'another-repo'));
});

test('soul opens its exact file in nvim with inherited terminal and returns editor status', async t => {
  const { Soul } = await import('../src/soul.js');
  const { store } = await fixture(t);
  const soul = new Soul(store.root, []);
  assert.equal(await soul.edit((command, args, options) => {
    assert.equal(command, 'nvim');
    assert.deepEqual(args, [soul.path]);
    assert.deepEqual(options, { stdio: 'inherit' });
    return { status: 7 };
  }), 7);
  await assert.rejects(soul.edit(() => ({ error: new Error('not found') })), /Could not open Neovim/);
});

test('remove deletes personal skills, including ones with broken metadata, and both links', async t => {
  const { store } = await fixture(t);
  const path = await store.create('personal', 'My workflow');
  await fs.writeFile(join(path, 'SKILL.md'), 'broken metadata');
  assert.equal((await store.removable()).get('personal').kind, 'personal');
  await store.remove('personal');
  assert.equal(await exists(path), null);
  for (const target of store.targets) assert.equal(await exists(join(target, 'personal')), null);
  assert.equal(await store.install({}), 0);
});

test('remove unregisters local skills without deleting their external checkout', async t => {
  const { store, dir } = await fixture(t);
  const path = join(dir, 'checkout');
  await fs.mkdir(path);
  await fs.writeFile(join(path, 'SKILL.md'), skill);
  await store.localLink(path);
  await store.remove('example');
  assert.deepEqual(await fs.readFile(join(path, 'SKILL.md')), skill);
  for (const target of store.targets) assert.equal(await exists(join(target, 'example')), null);
  assert.equal((await store.personal()).size, 0);
});

test('remove of a personal symlink keeps its target and unknown names fail clearly', async t => {
  const { store, dir } = await fixture(t);
  const path = join(dir, 'checkout');
  await fs.mkdir(path);
  await fs.writeFile(join(path, 'SKILL.md'), skill);
  await fs.symlink(path, join(store.root, 'skills/example'));
  await store.install({});
  await store.remove('example');
  assert.deepEqual(await fs.readFile(join(path, 'SKILL.md')), skill);
  assert.equal(await exists(join(store.root, 'skills/example')), null);
  await assert.rejects(store.remove('missing'), /Unknown skill: missing/);
});

test('discovery skips malformed metadata with its path, but preserves valid selections', async () => {
  const github = new GitHub({ token: '' });
  github.resolve = async () => ({ repo: 'owner/repo', ref: 'main', commit: entry.commit, tree: 'root' });
  github.tree = async () => [
    { path: 'skills/example', type: 'tree', sha: entry.tree },
    { path: 'skills/example/SKILL.md', type: 'blob', mode: '100644', sha: 'good' },
    { path: 'skills/broken/SKILL.md', type: 'blob', mode: '100644', sha: 'bad' },
  ];
  github.blob = async (_repo, sha) => sha === 'good' ? skill : Buffer.from('---\nname: broken\ndescription: Use for access: "prod"\n---\n');
  const warnings = [];
  const skills = await github.discover('owner/repo', undefined, warning => warnings.push(warning));
  assert.deepEqual(skills.map(s => s.name), ['example']);
  assert.equal(warnings[0].path, 'skills/broken/SKILL.md');
  assert.match(warnings[0].message, /Invalid YAML frontmatter/);
  assert.ok(!warnings[0].message.includes('\n'));
  github.blob = async () => { throw new Error('GitHub returned 403'); };
  await assert.rejects(github.discover('owner/repo'), /403/);
});

test('discovery cache persists results by repo and ref and ignores corrupt files', async t => {
  const { DiscoveryCache } = await import('../src/discovery.js');
  const { store } = await fixture(t);
  const cache = new DiscoveryCache(store.root);
  const skills = [{ ...entry, description: 'Test skill' }];
  assert.equal(await cache.load('Owner/Repo'), null);
  const result = await cache.refresh({ discover: async () => skills }, 'Owner/Repo');
  assert.deepEqual(result.skills, skills);
  assert.deepEqual(await cache.load('owner/repo'), skills);
  assert.equal(await cache.load('owner/repo', 'dev'), null);
  await fs.writeFile(cache.file('owner/repo'), '{broken');
  assert.equal(await cache.load('owner/repo'), null);
});

test('failed background refresh preserves cached results and reports the error', async t => {
  const { DiscoveryCache } = await import('../src/discovery.js');
  const { store } = await fixture(t);
  const cache = new DiscoveryCache(store.root);
  const skills = [{ ...entry, description: 'Test skill' }];
  await cache.refresh({ discover: async () => skills }, 'owner/repo');
  const result = await cache.refresh({ discover: async () => { throw new Error('offline'); } }, 'owner/repo');
  assert.match(result.error.message, /offline/);
  assert.deepEqual(await cache.load('owner/repo'), skills);
});

test('live picker refresh preserves row identities, appends new skills, and disables removed ones', async () => {
  const { updateChoices } = await import('../src/discovery.js');
  const options = [{ value: 'a' }, { value: 'b' }, { value: 'gone' }];
  const focused = options[1];
  updateChoices(options, [{ name: 'B', path: 'b' }, { name: 'New', path: 'new' }, { name: 'A', path: 'a' }]);
  assert.equal(options[1], focused);
  assert.deepEqual(options.map(o => o.value), ['a', 'b', 'gone', 'new']);
  assert.equal(options[2].disabled, true);
  assert.equal(options[3].label, 'New');
  assert.equal(options[1].disabled, false);
});

test('cached selection resolves the current commit and tree, never its old commit', async () => {
  const { latestSelected } = await import('../src/discovery.js');
  const latest = { repo: 'owner/repo', ref: 'dev', commit: 'c'.repeat(40), tree: 'root' };
  const github = {
    resolve: async (repo, ref) => { assert.equal(ref, 'dev'); return latest; },
    tree: async () => [{ type: 'tree', path: entry.path, sha: 'd'.repeat(40) }],
  };
  const [selected] = await latestSelected(github, 'owner/repo', 'dev', [entry]);
  assert.equal(selected.commit, latest.commit);
  assert.equal(selected.tree, 'd'.repeat(40));
  assert.equal(selected.ref, 'dev');
  await assert.rejects(latestSelected(github, 'owner/repo', 'dev', [{ ...entry, path: 'removed' }]), /no longer/);
});

test('picker groups nested skill folders with distinct labels and stable path values', async () => {
  const { skillGroup, skillOptions } = await import('../src/picker.js');
  assert.equal(skillGroup('cursor-team-kit/skills/deslop'), 'cursor-team-kit');
  assert.equal(skillGroup('third_party/github/skills/query'), 'third_party/github');
  assert.equal(skillGroup('skills/engineering/review'), 'skills/engineering');
  assert.equal(skillGroup('skills/review'), 'Skills');
  assert.equal(skillGroup(''), 'Repository root');
  const options = skillOptions([
    { name: 'review', path: 'third_party/github/skills/review' },
    { name: 'review', path: 'cursor-team-kit/skills/review' },
    { name: 'deslop', path: 'cursor-team-kit/skills/deslop' },
  ]);
  assert.deepEqual(options.map(o => o.group), ['cursor-team-kit', 'cursor-team-kit', 'third_party/github']);
  assert.deepEqual(options.map(o => o.label), ['deslop', 'review', 'review']);
  assert.equal(new Set(options.map(o => o.value)).size, 3);
});

test('viewport scrolls only at its edges and keeps a full window when reversing direction', async () => {
  const { PickerViewport } = await import('../src/viewport.js');
  const options = Array.from({ length: 40 }, (_, i) => ({ value: `${i}`, group: `group-${Math.floor(i / 4)}` }));
  const viewport = new PickerViewport();
  for (let cursor = 0; cursor < options.length; cursor++) {
    const view = viewport.layout(options, cursor, 10);
    assert.equal(view.rows.length, 10);
    assert.equal(view.rows.filter(row => row.focused).length, 1);
  }
  const bottom = viewport.start;
  assert.equal(viewport.layout(options, 39, 10).below, false);
  for (const cursor of [38, 37, 38, 39]) {
    viewport.layout(options, cursor, 10);
    assert.equal(viewport.start, bottom, 'Changing direction inside the viewport must not recenter it');
  }
  for (let cursor = 38; cursor >= 0; cursor--) {
    const view = viewport.layout(options, cursor, 10);
    assert.equal(view.rows.length, 10);
    assert.equal(view.rows.filter(row => row.focused).length, 1);
  }
  assert.equal(viewport.start, 0, 'Returning to the first skill restores its group heading');
  viewport.layout(options, 0, 1000);
  assert.equal(viewport.start, 0);
});

test('picker frames keep the same height and fit the terminal across groups, selection and resize', async () => {
  const { PickerViewport } = await import('../src/viewport.js');
  const { skillOptions, renderPicker } = await import('../src/picker.js');
  const { default: stringWidth } = await import('fast-string-width');
  const options = skillOptions(Array.from({ length: 60 }, (_, i) => ({
    name: `skill-${i}`, path: `very-long-plugin-name-${Math.floor(i / 3)}/skills/skill-${i}`,
    description: 'A long description with emoji 👩‍💻 and wide text 中文 '.repeat(10),
  })));
  const viewport = new PickerViewport();
  for (const output of [{ rows: 14, columns: 45 }, { rows: 30, columns: 100 }, { rows: 18, columns: 60 }]) {
    for (const cursor of [...options.keys(), ...[...options.keys()].reverse()]) {
      const frame = renderPicker({ options, cursor, value: options.slice(0, cursor).map(o => o.value), state: cursor % 2 ? 'active' : 'error', error: 'Select at least one skill.' }, viewport, 'Which skills would you like to add? (refreshing…)', output);
      const lines = frame.split('\n');
      assert.equal(lines.length, output.rows - 2);
      for (const line of lines) assert.ok(stringWidth(line) < output.columns, `Line wraps: ${line}`);
    }
  }
});

test('install skips inaccessible private repos, installs public skills, and retries after authentication', async t => {
  const { store } = await fixture(t);
  const locked = { ...entry, digest: digest(files) };
  delete locked.name;
  await store.save({ version: 1, skills: {
    hidden: { ...locked, repo: 'owner/private', private: true },
    'hidden-two': { ...locked, repo: 'owner/private', private: true },
    example: { ...locked, private: false },
  } });
  const before = await fs.readFile(store.lockPath, 'utf8');
  const warnings = [];
  let requests = 0;
  const count = await store.install({
    api: async () => { requests++; throw Object.assign(new Error('Not found'), { status: 404 }); },
    download: async e => { assert.equal(e.name, 'example'); return files; },
  }, message => warnings.push(message));
  assert.equal(count, 1);
  assert.equal(requests, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /owner\/private/);
  for (const target of store.targets) {
    assert.equal(await exists(join(target, 'hidden')), null);
    assert.equal(await fs.readlink(join(target, 'example')), store.destination('example'));
  }
  assert.equal(await fs.readFile(store.lockPath, 'utf8'), before);
  assert.equal(await store.install({ api: async () => ({ private: true }), download: async () => files }), 3);
  assert.equal((await store.lock()).skills.hidden.private, true);
  assert.equal(await store.install({ api: () => assert.fail('Installed private skills work offline') }), 3);
});

test('private install does not hide server failures or integrity errors', async t => {
  const { store } = await fixture(t);
  await store.save({ version: 1, skills: { example: { ...entry, private: true, digest: digest(files) } } });
  await assert.rejects(store.install({ api: async () => { throw Object.assign(new Error('Server failure'), { status: 500 }); } }), /Server failure/);
  await assert.rejects(store.install({ api: async () => ({}), download: async () => [] }), /do not match the lock/);
});

test('explicit refs record repository privacy', async () => {
  const github = new GitHub({ token: '', fetcher: async url => ({ ok: true, json: async () => url.endsWith('/repos/owner/repo')
    ? { private: true, default_branch: 'main' }
    : { sha: entry.commit, commit: { tree: { sha: entry.tree } } } }) });
  assert.equal((await github.resolve('owner/repo', 'dev')).private, true);
});
