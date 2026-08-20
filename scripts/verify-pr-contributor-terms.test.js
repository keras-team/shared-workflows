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

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const verifyPrContributorTerms = require('./verify-pr-contributor-terms.js');

describe('verifyPrContributorTerms', () => {
  let savedEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  function createHarness({ pr, env = {}, context = null }) {
    let failedMessage = null;
    const infoMessages = [];

    const core = {
      info: (msg) => infoMessages.push(msg),
      setFailed: (msg) => { failedMessage = msg; },
    };

    const github = {
      rest: {
        pulls: {
          get: async () => ({ data: pr }),
        },
      },
    };

    const defaultContext = {
      repo: { owner: 'keras-team', repo: 'keras' },
      payload: { pull_request: { number: 100 } },
    };

    // Apply environment overrides for test.
    Object.keys(env).forEach((k) => { process.env[k] = env[k]; });
    ['EXEMPT_USERS', 'EXEMPT_ASSOCIATIONS', 'REQUIRED_TERMS'].forEach((k) => {
      if (!(k in env)) delete process.env[k];
    });

    return {
      run: () => verifyPrContributorTerms({
        github,
        context: context || defaultContext,
        core,
      }),
      getFailedMessage: () => failedMessage,
      getInfoMessages: () => infoMessages,
    };
  }

  it('exempts organization MEMBER without requiring checkboxes', async () => {
    const harness = createHarness({
      pr: {
        number: 100,
        author_association: 'MEMBER',
        user: { login: 'keras-member', type: 'User' },
        body: 'Simple bugfix without any checklist',
      },
    });

    await harness.run();
    assert.strictEqual(harness.getFailedMessage(), null);
    assert.ok(harness.getInfoMessages().some((m) => m.includes('is exempt')));
  });

  it('exempts organization OWNER without requiring checkboxes', async () => {
    const harness = createHarness({
      pr: {
        number: 100,
        author_association: 'OWNER',
        user: { login: 'keras-owner', type: 'User' },
        body: 'New feature',
      },
    });

    await harness.run();
    assert.strictEqual(harness.getFailedMessage(), null);
    assert.ok(harness.getInfoMessages().some((m) => m.includes('is exempt')));
  });

  it('exempts repository COLLABORATOR without requiring checkboxes', async () => {
    const harness = createHarness({
      pr: {
        number: 100,
        author_association: 'COLLABORATOR',
        user: { login: 'keras-collaborator', type: 'User' },
        body: 'Doc update',
      },
    });

    await harness.run();
    assert.strictEqual(harness.getFailedMessage(), null);
    assert.ok(harness.getInfoMessages().some((m) => m.includes('is exempt')));
  });

  it('exempts bot accounts by user type or login suffix', async () => {
    const harnessBotType = createHarness({
      pr: {
        number: 100,
        author_association: 'NONE',
        user: { login: 'google-oss-robot', type: 'Bot' },
        body: 'Automated sync',
      },
    });

    await harnessBotType.run();
    assert.strictEqual(harnessBotType.getFailedMessage(), null);

    const harnessBotSuffix = createHarness({
      pr: {
        number: 100,
        author_association: 'NONE',
        user: { login: 'dependabot[bot]', type: 'User' },
        body: 'Bump dependencies',
      },
    });

    await harnessBotSuffix.run();
    assert.strictEqual(harnessBotSuffix.getFailedMessage(), null);
  });

  it('exempts explicitly configured usernames in EXEMPT_USERS', async () => {
    const harness = createHarness({
      pr: {
        number: 100,
        author_association: 'NONE',
        user: { login: 'trusted-external-bot', type: 'User' },
        body: 'Scheduled sync',
      },
      env: {
        EXEMPT_USERS: 'trusted-external-bot,other-user',
      },
    });

    await harness.run();
    assert.strictEqual(harness.getFailedMessage(), null);
    assert.ok(harness.getInfoMessages().some((m) => m.includes('is exempt')));
  });

  it('passes for external contributors with all checkboxes checked', async () => {
    const harness = createHarness({
      pr: {
        number: 100,
        author_association: 'NONE',
        user: { login: 'new-contributor', type: 'User' },
        body: `
## Description
Fix a bug in layers.

## Contributor Agreement
- [x] I am a human, and not a bot.
- [X] I will be responsible for responding to review comments in a timely manner.
* [x] I will work with the maintainers to push this PR forward until submission.
`,
      },
    });

    await harness.run();
    assert.strictEqual(harness.getFailedMessage(), null);
    assert.ok(harness.getInfoMessages().some((m) => m.includes('All contributor agreement terms accepted')));
  });

  it('fails for external contributors with missing or unchecked checkboxes', async () => {
    const harness = createHarness({
      pr: {
        number: 100,
        author_association: 'CONTRIBUTOR',
        user: { login: 'contributor', type: 'User' },
        body: `
## Description
My PR

- [ ] I am a human, and not a bot.
- [x] I will be responsible for responding to review comments in a timely manner.
- [ ] I will work with the maintainers to push this PR forward until submission.
`,
      },
    });

    await harness.run();
    const failedMsg = harness.getFailedMessage();
    assert.notStrictEqual(failedMsg, null);
    assert.ok(failedMsg.includes('I am a human, and not a bot.'));
    assert.ok(failedMsg.includes('I will work with the maintainers to push this PR forward until submission.'));
    assert.ok(!failedMsg.includes('I will be responsible for responding to review comments in a timely manner.'));
  });

  it('verifies custom terms when REQUIRED_TERMS input is specified', async () => {
    const harness = createHarness({
      pr: {
        number: 100,
        author_association: 'NONE',
        user: { login: 'contributor', type: 'User' },
        body: `
- [x] Custom term 1
- [ ] Custom term 2
`,
      },
      env: {
        REQUIRED_TERMS: 'Custom term 1\nCustom term 2',
      },
    });

    await harness.run();
    const failedMsg = harness.getFailedMessage();
    assert.notStrictEqual(failedMsg, null);
    assert.ok(failedMsg.includes('Custom term 2'));
    assert.ok(!failedMsg.includes('Custom term 1'));
  });
});
