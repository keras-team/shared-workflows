/**
 * @license
 * Copyright 2026 The Keras Authors. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const release = require('./release.js');

const VERSION_FILE = 'pkg/src/version.py';

const tempDirs = [];
process.on('exit', () => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function sh(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/**
 * A real remote with `master` at 0.34.0.dev0 and `r0.33` at 0.33.0, plus the
 * clone the workflow would run in. `fixA`, `fixB` and `clash` landed on master
 * in that order after r0.33 was cut; `clash` conflicts with r0.33.
 */
function createHarness({
  permission = 'write',
  tags = ['v0.33.0', 'v0.33.0.dev0', 'v0.32.1'],
  releases = [],
  secondVersionFile = false,
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-test-'));
  tempDirs.push(root);
  const remote = path.join(root, 'remote.git');
  const seed = path.join(root, 'seed');
  const cwd = path.join(root, 'target');
  sh(root, ['-c', 'init.defaultBranch=master', 'init', '--quiet', '--bare', remote]);
  sh(root, ['-c', 'init.defaultBranch=master', 'init', '--quiet', seed]);
  sh(seed, ['config', 'user.name', 'seed']);
  sh(seed, ['config', 'user.email', 'seed@example.com']);
  sh(seed, ['remote', 'add', 'origin', remote]);
  const commit = (file, content, message) => {
    fs.mkdirSync(path.dirname(path.join(seed, file)), { recursive: true });
    fs.writeFileSync(path.join(seed, file), content);
    sh(seed, ['add', file]);
    sh(seed, ['commit', '--quiet', '-m', message]);
    return sh(seed, ['rev-parse', 'HEAD']);
  };
  const versionText = (version) => `# Version.\n__version__ = "${version}"\n\ndef version():\n    return __version__\n`;

  const shas = {};
  if (secondVersionFile) {
    commit('other/version.py', versionText('9.9.9'), 'Second version file');
  }
  shas.root = commit(VERSION_FILE, versionText('0.34.0.dev0'), 'Start');
  sh(seed, ['checkout', '--quiet', '-b', 'r0.33']);
  commit(VERSION_FILE, versionText('0.33.0'), 'Bump version to 0.33.0');
  shas.releaseOnly = commit('clash.txt', 'release\n', 'Release only change');
  sh(seed, ['checkout', '--quiet', 'master']);
  shas.fixA = commit('a.txt', 'a\n', 'Fix A');
  shas.fixB = commit('b.txt', 'b\n', 'Fix B');
  shas.clash = commit('clash.txt', 'master\n', 'Clash');
  sh(seed, ['push', '--quiet', 'origin', 'master', 'r0.33']);
  sh(root, ['clone', '--quiet', remote, cwd]);

  const calls = { pulls: [], notes: [], releases: [] };
  const state = { failed: null, summary: '' };
  const core = {
    setFailed: (message) => {
      state.failed = message;
    },
    summary: {
      addRaw(text) {
        state.summary += text;
        return this;
      },
      write: async () => {},
    },
  };
  const github = {
    paginate: async (method, params) => (await method(params)).data,
    rest: {
      repos: {
        get: async () => ({ data: { default_branch: 'master' } }),
        getCollaboratorPermissionLevel: async () => ({ data: { permission } }),
        listTags: async () => ({ data: tags.map((name) => ({ name })) }),
        listReleases: async () => ({ data: releases }),
        generateReleaseNotes: async (params) => {
          calls.notes.push(params);
          return { data: { body: 'NOTES' } };
        },
        createRelease: async (params) => {
          calls.releases.push(params);
          return { data: { html_url: 'https://example.com/release' } };
        },
      },
      users: {
        getByUsername: async () => ({ data: { id: 583231 } }),
      },
      pulls: {
        create: async (params) => {
          calls.pulls.push(params);
          return { data: { html_url: 'https://example.com/pull/1' } };
        },
      },
    },
  };
  const run = async (overrides = {}) => {
    const env = {
      RELEASE_ACTION: 'prepare',
      RELEASE_REPO: 'keras-hub',
      RELEASE_TYPE: 'patch',
      RELEASE_VERSION: '',
      RELEASE_COMMIT: '',
      RELEASE_CHERRY_PICKS: '',
      RELEASE_STAGE: 'final',
      RELEASE_DRY_RUN: 'false',
      RELEASE_ACTOR: 'octocat',
      ...overrides,
    };
    await release({ github, core, env, cwd });
    return state;
  };
  const remoteRefs = () => sh(root, ['--git-dir', remote, 'for-each-ref', '--format=%(refname:short)']).split('\n');
  const remoteGit = (args) => sh(root, ['--git-dir', remote, ...args]);
  // What actions/checkout does at the start of the next run.
  const fetch = () => sh(cwd, ['fetch', '--quiet']);
  return { run, shas, calls, fetch, remoteRefs, remoteGit };
}

describe('nextVersion', () => {
  const tags = ['v3.12.4', 'v3.15.1', 'v3.15.0', 'v3.16.0.dev0', 'unrelated'];

  it('counts from the highest final tag', () => {
    assert.strictEqual(release.nextVersion(tags, 'major', 'final'), '4.0.0');
    assert.strictEqual(release.nextVersion(tags, 'minor', 'final'), '3.16.0');
    assert.strictEqual(release.nextVersion(tags, 'patch', 'final'), '3.15.2');
  });

  it('compares numerically, not as text', () => {
    assert.strictEqual(release.nextVersion(['v0.9.0', 'v0.10.0'], 'minor', 'final'), '0.11.0');
  });

  it('appends .dev0 for the dev stage', () => {
    assert.strictEqual(release.nextVersion(tags, 'minor', 'dev'), '3.16.0.dev0');
  });

  it('fails when there is no final tag to count from', () => {
    assert.throws(() => release.nextVersion(['v0.1.0.dev0'], 'minor', 'final'), /Type the version yourself/);
  });
});

describe('previousTag', () => {
  const tags = ['v0.34.0', 'v0.34.0.dev0', 'v0.33.1', 'v0.33.0'];

  it('is the highest final tag below the version', () => {
    assert.strictEqual(release.previousTag(tags, '0.35.0'), 'v0.34.0');
    assert.strictEqual(release.previousTag(tags, '0.33.2'), 'v0.33.1');
  });

  it('skips the dev release of the same version', () => {
    assert.strictEqual(release.previousTag(['v0.33.0', 'v0.34.0.dev0'], '0.34.0'), 'v0.33.0');
    assert.strictEqual(release.previousTag(['v0.33.0'], '0.34.0.dev0'), 'v0.33.0');
  });

  it('is undefined for a first release', () => {
    assert.strictEqual(release.previousTag(['v0.1.0.dev0'], '0.1.0'), undefined);
  });
});

describe('sortPicks', () => {
  it('returns the picks in mainline order without repeats', () => {
    assert.deepStrictEqual(release.sortPicks(['a', 'b', 'c', 'd'], ['d', 'b', 'd']), ['b', 'd']);
  });

  it('rejects a commit that is not on the mainline', () => {
    assert.throws(() => release.sortPicks(['a', 'b'], ['a', 'z']), /cannot be cherry-picked: z/);
  });
});

describe('bumpVersion', () => {
  it('replaces only the version line', () => {
    assert.strictEqual(
      release.bumpVersion('# v\n__version__ = "0.34.0.dev0"\nx = 1\n', '0.34.0'),
      '# v\n__version__ = "0.34.0"\nx = 1\n'
    );
  });

  it('fails when there is no version line', () => {
    assert.throws(() => release.bumpVersion('version = "1"\n', '1.0.0'), /No `__version__ = ` line/);
  });
});

describe('parseInputs', () => {
  const valid = {
    RELEASE_ACTION: 'prepare',
    RELEASE_REPO: 'keras-hub',
    RELEASE_TYPE: 'minor',
    RELEASE_STAGE: 'final',
    RELEASE_ACTOR: 'octocat',
  };

  it('splits cherry-picks on spaces and commas and defaults to a dry run', () => {
    const inputs = release.parseInputs({
      ...valid,
      RELEASE_CHERRY_PICKS: ' abc1234, def5678\nabc9999 ',
      RELEASE_VERSION: 'v1.2.3',
    });
    assert.deepStrictEqual(inputs.picks, ['abc1234', 'def5678', 'abc9999']);
    assert.strictEqual(inputs.version, '1.2.3');
    assert.strictEqual(inputs.dryRun, true);
  });

  for (const [name, override, pattern] of [
    ['an unknown action', { RELEASE_ACTION: 'publish' }, /action must be/],
    ['a repo path', { RELEASE_REPO: 'other-org/keras' }, /repo must be/],
    ['an unknown release type', { RELEASE_TYPE: 'huge' }, /release_type must be/],
    ['an unknown stage', { RELEASE_STAGE: 'beta' }, /stage must be/],
    ['a malformed version', { RELEASE_VERSION: '1.2' }, /is not of the form/],
    ['a cherry-pick that is not a hash', { RELEASE_CHERRY_PICKS: '--force' }, /is not a commit hash/],
    ['a commit that is not a hash', { RELEASE_COMMIT: 'master' }, /is not a commit hash/],
  ]) {
    it(`rejects ${name}`, () => {
      assert.throws(() => release.parseInputs({ ...valid, ...override }), pattern);
    });
  }
});

describe('release prepare', () => {
  it('patch: applies the picks in master order, bumps the version and opens a PR', async () => {
    const h = createHarness();
    // Given newest first, one as a short hash.
    const state = await h.run({ RELEASE_CHERRY_PICKS: `${h.shas.fixB.slice(0, 7)} ${h.shas.fixA}` });

    assert.strictEqual(state.failed, null);
    assert.deepStrictEqual(
      h.remoteGit(['log', '--format=%s', 'r0.33..release-prep/0.33.1']).split('\n'),
      ['Bump version to 0.33.1', 'Fix B', 'Fix A']
    );
    assert.match(h.remoteGit(['show', `release-prep/0.33.1:${VERSION_FILE}`]), /^__version__ = "0\.33\.1"$/m);
    assert.strictEqual(
      h.remoteGit(['log', '-1', '--format=%an <%ae>', 'release-prep/0.33.1']),
      'octocat <583231+octocat@users.noreply.github.com>'
    );
    assert.strictEqual(h.calls.pulls.length, 1);
    assert.strictEqual(h.calls.pulls[0].owner, 'keras-team');
    assert.strictEqual(h.calls.pulls[0].base, 'r0.33');
    assert.strictEqual(h.calls.pulls[0].head, 'release-prep/0.33.1');
  });

  it('minor: cuts the release branch at the given commit and opens the bump PR', async () => {
    const h = createHarness();
    const state = await h.run({ RELEASE_TYPE: 'minor', RELEASE_COMMIT: h.shas.fixA });

    assert.strictEqual(state.failed, null);
    assert.strictEqual(h.remoteGit(['rev-parse', 'r0.34']), h.shas.fixA);
    assert.match(h.remoteGit(['show', `release-prep/0.34.0:${VERSION_FILE}`]), /^__version__ = "0\.34\.0"$/m);
    assert.strictEqual(h.calls.pulls[0].base, 'r0.34');
  });

  it('minor dev: only cuts the branch when the version is already right', async () => {
    const h = createHarness();
    const state = await h.run({ RELEASE_TYPE: 'minor', RELEASE_STAGE: 'dev' });

    assert.strictEqual(state.failed, null);
    assert.strictEqual(h.remoteGit(['rev-parse', 'r0.34']), h.shas.clash);
    assert.strictEqual(h.calls.pulls.length, 0);
    assert.match(state.summary, /No PR needed/);
  });

  it('dry run: reports the plan and changes nothing', async () => {
    const h = createHarness();
    const before = h.remoteRefs();
    const state = await h.run({ RELEASE_TYPE: 'minor', RELEASE_DRY_RUN: 'true' });

    assert.strictEqual(state.failed, null);
    assert.match(state.summary, /prepare keras-hub 0\.34\.0 \(dry run/);
    assert.deepStrictEqual(h.remoteRefs(), before);
    assert.strictEqual(h.calls.pulls.length, 0);
  });

  it('stops on a cherry-pick conflict without pushing', async () => {
    const h = createHarness();
    const before = h.remoteRefs();
    const state = await h.run({ RELEASE_CHERRY_PICKS: h.shas.clash });

    assert.match(state.failed, new RegExp(`Cherry-pick of ${h.shas.clash} onto r0\\.33 failed`));
    assert.deepStrictEqual(h.remoteRefs(), before);
    assert.strictEqual(h.calls.pulls.length, 0);
  });

  it('refuses a patch when the release branch does not exist', async () => {
    const h = createHarness();
    const state = await h.run({ RELEASE_VERSION: '0.31.5' });
    assert.match(state.failed, /r0\.31 does not exist/);
  });

  it('refuses a commit when the release branch already exists', async () => {
    const h = createHarness();
    const state = await h.run({ RELEASE_COMMIT: h.shas.fixA });
    assert.match(state.failed, /`commit` does not apply/);
  });

  it('refuses to cut the release branch from a commit that is not on master', async () => {
    const h = createHarness();
    const state = await h.run({ RELEASE_TYPE: 'minor', RELEASE_COMMIT: h.shas.releaseOnly });
    assert.match(state.failed, /is not on master/);
    assert.ok(!h.remoteRefs().includes('r0.34'));
  });

  it('refuses a repo with more than one version file', async () => {
    const h = createHarness({ secondVersionFile: true });
    const state = await h.run({ RELEASE_CHERRY_PICKS: h.shas.fixA });
    assert.match(state.failed, /Expected exactly one version\.py/);
    assert.strictEqual(h.calls.pulls.length, 0);
  });

  it('refuses when there is nothing to change', async () => {
    const h = createHarness({ tags: [] });
    const state = await h.run({ RELEASE_VERSION: '0.33.0' });
    assert.match(state.failed, /already at 0\.33\.0/);
  });

  it('refuses a second prepare for the same version', async () => {
    const h = createHarness();
    await h.run({ RELEASE_CHERRY_PICKS: h.shas.fixA });
    h.fetch();
    const state = await h.run({ RELEASE_CHERRY_PICKS: h.shas.fixA });
    assert.match(state.failed, /release-prep\/0\.33\.1 already exists/);
  });

  it('refuses a person without write access', async () => {
    const h = createHarness({ permission: 'read' });
    const state = await h.run({ RELEASE_CHERRY_PICKS: h.shas.fixA });
    assert.match(state.failed, /@octocat needs write access/);
    assert.strictEqual(h.calls.pulls.length, 0);
  });

  it('refuses a version whose tag already exists', async () => {
    const h = createHarness();
    const state = await h.run({ RELEASE_VERSION: '0.33.0' });
    assert.match(state.failed, /Tag v0\.33\.0 already exists/);
  });
});

describe('release draft-release', () => {
  it('drafts a final release at the checked commit, with notes since the last final release', async () => {
    const h = createHarness({ tags: ['v0.32.0', 'v0.33.0.dev0'] });
    const state = await h.run({ RELEASE_ACTION: 'draft-release', RELEASE_VERSION: '0.33.0' });
    const target = h.remoteGit(['rev-parse', 'r0.33']);

    assert.strictEqual(state.failed, null);
    assert.deepStrictEqual(h.calls.notes, [
      {
        owner: 'keras-team',
        repo: 'keras-hub',
        tag_name: 'v0.33.0',
        target_commitish: target,
        previous_tag_name: 'v0.32.0',
      },
    ]);
    assert.deepStrictEqual(h.calls.releases, [
      {
        owner: 'keras-team',
        repo: 'keras-hub',
        tag_name: 'v0.33.0',
        target_commitish: target,
        name: 'v0.33.0',
        body: 'NOTES',
        draft: true,
        prerelease: false,
      },
    ]);
  });

  it('marks a dev version as a pre-release', async () => {
    const h = createHarness();
    await h.run({ RELEASE_TYPE: 'minor', RELEASE_STAGE: 'dev' });
    h.fetch();
    const state = await h.run({ RELEASE_ACTION: 'draft-release', RELEASE_TYPE: 'minor', RELEASE_STAGE: 'dev' });

    assert.strictEqual(state.failed, null);
    assert.strictEqual(h.calls.releases[0].tag_name, 'v0.34.0.dev0');
    assert.strictEqual(h.calls.releases[0].prerelease, true);
  });

  it('refuses while the prepare PR is not merged', async () => {
    const h = createHarness();
    const state = await h.run({ RELEASE_ACTION: 'draft-release' });
    assert.match(state.failed, /on r0\.33 is not at 0\.33\.1/);
    assert.strictEqual(h.calls.releases.length, 0);
  });

  it('refuses when the release branch does not exist', async () => {
    const h = createHarness();
    const state = await h.run({ RELEASE_ACTION: 'draft-release', RELEASE_VERSION: '0.31.5' });
    assert.match(state.failed, /r0\.31 does not exist\. Run prepare first/);
  });

  it('refuses when a release for the tag already exists', async () => {
    const h = createHarness({
      tags: ['v0.32.0'],
      releases: [{ tag_name: 'v0.33.0', html_url: 'https://example.com/draft' }],
    });
    const state = await h.run({ RELEASE_ACTION: 'draft-release', RELEASE_VERSION: '0.33.0' });
    assert.match(state.failed, /already exists: https:\/\/example\.com\/draft/);
    assert.strictEqual(h.calls.releases.length, 0);
  });

  it('dry run: creates nothing', async () => {
    const h = createHarness({ tags: ['v0.32.0'] });
    const state = await h.run({
      RELEASE_ACTION: 'draft-release',
      RELEASE_VERSION: '0.33.0',
      RELEASE_DRY_RUN: 'true',
    });
    assert.strictEqual(state.failed, null);
    assert.match(state.summary, /Would draft release `v0\.33\.0`/);
    assert.strictEqual(h.calls.notes.length, 0);
    assert.strictEqual(h.calls.releases.length, 0);
  });
});
