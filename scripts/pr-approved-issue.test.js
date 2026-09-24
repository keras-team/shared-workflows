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
const prApprovedIssue = require('./pr-approved-issue.js');

describe('prApprovedIssue', () => {
  function createHarness({
    owner = 'keras-team',
    repo = 'keras-hub',
    action = 'opened',
    pr = null,
    payloadPr = undefined,
    issuesByNumber = {},
    graphqlError = null,
  }) {
    const infoMessages = [];
    const warningMessages = [];
    let failedMessage = null;
    const fetchedIssues = [];
    const graphqlCalls = [];
    const createdComments = [];

    const core = {
      info: (msg) => infoMessages.push(msg),
      warning: (msg) => warningMessages.push(msg),
      setFailed: (msg) => {
        failedMessage = msg;
      },
    };

    const github = {
      rest: {
        pulls: {
          get: async () => ({ data: pr }),
        },
        issues: {
          get: async ({ issue_number }) => {
            fetchedIssues.push(issue_number);
            if (!(issue_number in issuesByNumber)) {
              throw new Error('Not Found');
            }
            return { data: issuesByNumber[issue_number] };
          },
          createComment: async (params) => {
            createdComments.push(params);
          },
        },
      },
      graphql: async (query, variables) => {
        graphqlCalls.push({ query, variables });
        if (graphqlError) {
          throw graphqlError;
        }
        return {};
      },
    };

    const context = {
      repo: { owner, repo },
      payload: {
        action,
        pull_request: payloadPr !== undefined ? payloadPr : (pr ? { number: pr.number } : null),
      },
    };

    return {
      run: () => prApprovedIssue({ github, context, core }),
      getInfoMessages: () => infoMessages,
      getWarningMessages: () => warningMessages,
      getFailedMessage: () => failedMessage,
      getFetchedIssues: () => fetchedIssues,
      getGraphqlCalls: () => graphqlCalls,
      getCreatedComments: () => createdComments,
    };
  }

  it('ignores non-pull-request payloads safely', async () => {
    const harness = createHarness({ pr: null });
    await harness.run();
    assert.strictEqual(harness.getFailedMessage(), null);
    assert.ok(harness.getInfoMessages().includes('Not a pull request payload.'));
  });

  it('skips bots and bypassed author associations (OWNER, MEMBER, COLLABORATOR)', async () => {
    for (const [login, type, association] of [
      ['bot-account', 'Bot', 'NONE'],
      ['dependabot[bot]', 'User', 'NONE'],
      ['owner-user', 'User', 'OWNER'],
      ['member-user', 'User', 'MEMBER'],
      ['collab-user', 'User', 'COLLABORATOR'],
    ]) {
      const harness = createHarness({
        pr: {
          number: 10,
          node_id: 'PR_10',
          draft: false,
          author_association: association,
          user: { login, type },
          body: 'No issue link needed',
        },
      });
      await harness.run();
      assert.strictEqual(harness.getFailedMessage(), null);
      assert.strictEqual(harness.getGraphqlCalls().length, 0);
      assert.strictEqual(harness.getCreatedComments().length, 0);
    }
  });

  it('fetches live PR state via pulls.get instead of relying on frozen event payload when re-run', async () => {
    const harness = createHarness({
      action: 'opened',
      // Stale frozen webhook payload from when the PR was first opened without an issue link:
      payloadPr: {
        number: 42,
        node_id: 'PR_42',
        draft: false,
        author_association: 'NONE',
        user: { login: 'external-dev', type: 'User' },
        body: 'Initial body without issue link',
      },
      // Live PR state on GitHub after the author updated the description:
      pr: {
        number: 42,
        node_id: 'PR_42',
        draft: true,
        author_association: 'NONE',
        user: { login: 'external-dev', type: 'User' },
        body: 'Fixes #123',
      },
      issuesByNumber: {
        123: { number: 123, assignees: [{ login: 'external-dev' }] },
      },
    });

    await harness.run();

    assert.strictEqual(harness.getFailedMessage(), null);
    assert.strictEqual(harness.getGraphqlCalls().length, 0);
    assert.strictEqual(harness.getCreatedComments().length, 0);
  });

  it('on opened without linked issue: converts non-draft PR to draft, posts comment, and fails', async () => {
    const harness = createHarness({
      action: 'opened',
      pr: {
        number: 42,
        node_id: 'PR_42',
        draft: false,
        author_association: 'NONE',
        user: { login: 'external-dev', type: 'User' },
        body: 'Here is my new feature.',
      },
    });

    await harness.run();

    // 1. Converted to draft via GraphQL.
    assert.strictEqual(harness.getGraphqlCalls().length, 1);
    assert.ok(harness.getGraphqlCalls()[0].query.includes('convertPullRequestToDraft'));
    assert.deepStrictEqual(harness.getGraphqlCalls()[0].variables, { id: 'PR_42' });

    // 2. Comment posted.
    assert.strictEqual(harness.getCreatedComments().length, 1);
    assert.ok(harness.getCreatedComments()[0].body.includes('No issue reference was found in the description.'));

    // 3. Workflow marked failed.
    assert.strictEqual(
      harness.getFailedMessage(),
      'No approved issue assigned to external-dev is linked in #42.'
    );
  });

  it('passes check without posting a comment or mutating draft state when an assigned issue is linked', async () => {
    const harness = createHarness({
      action: 'edited',
      pr: {
        number: 42,
        node_id: 'PR_42',
        draft: true,
        author_association: 'FIRST_TIME_CONTRIBUTOR',
        user: { login: 'External-Dev', type: 'User' },
        body: '## Approved issue link\nFixes #123\nAlso see keras-team/keras-hub#124 and https://github.com/keras-team/keras-hub/issues/125',
      },
      issuesByNumber: {
        123: { number: 123, assignees: [{ login: 'external-dev' }] },
        124: { number: 124, assignees: [{ login: 'someone-else' }] },
        125: { number: 125, assignees: [{ login: 'EXTERNAL-DEV' }] },
      },
    });

    await harness.run();

    // No GraphQL draft toggle and no comment when passing.
    assert.strictEqual(harness.getGraphqlCalls().length, 0);
    assert.strictEqual(harness.getCreatedComments().length, 0);
    assert.strictEqual(harness.getFailedMessage(), null);
    assert.ok(
      harness
        .getInfoMessages()
        .includes('Approved issue check passed for #42: #125, #123 assigned to @External-Dev.')
    );
  });

  it('ignores issue references inside HTML comments and the RFC policy issue #23601', async () => {
    const harness = createHarness({
      owner: 'keras-team',
      repo: 'keras',
      action: 'opened',
      pr: {
        number: 50,
        node_id: 'PR_50',
        draft: true,
        author_association: 'NONE',
        user: { login: 'contributor', type: 'User' },
        body: [
          '<!--- Link the approved issue, e.g. "Fixes #123" or https://github.com/keras-team/keras/issues/23601 -->',
          'Please review our [PR Contribution Policy](https://github.com/keras-team/keras/issues/23601).',
          'Fixes other-org/other-repo#100 and https://github.com/other-org/other-repo/issues/101 and #200',
        ].join('\n'),
      },
      issuesByNumber: {
        123: { number: 123, assignees: [{ login: 'contributor' }] },
        23601: { number: 23601, assignees: [{ login: 'contributor' }] },
        100: { number: 100, assignees: [{ login: 'contributor' }] },
        101: { number: 101, assignees: [{ login: 'contributor' }] },
        // #200 is a PR, not an issue.
        200: { number: 200, pull_request: {}, assignees: [{ login: 'contributor' }] },
      },
    });

    await harness.run();

    // Only #200 was fetched (neither #123 in HTML comment nor #23601 RFC policy issue was fetched).
    assert.deepStrictEqual(harness.getFetchedIssues(), [200]);
    assert.strictEqual(harness.getGraphqlCalls().length, 0);
    assert.notStrictEqual(harness.getFailedMessage(), null);
    assert.ok(
      harness.getCreatedComments()[0].body.includes('No issue reference was found in the description.')
    );
  });

  it('converts non-draft PR to draft and posts comment when edited to reference only unassigned issues', async () => {
    const harness = createHarness({
      action: 'edited',
      pr: {
        number: 55,
        node_id: 'PR_55',
        draft: false,
        author_association: 'CONTRIBUTOR',
        user: { login: 'contributor', type: 'User' },
        body: '## Approved issue link\nFixes #300 and #999',
      },
      issuesByNumber: {
        300: { number: 300, assignees: [{ login: 'other-user' }] },
        // #999 does not exist (throws Not Found).
      },
    });

    await harness.run();

    assert.strictEqual(harness.getGraphqlCalls().length, 1);
    assert.ok(harness.getGraphqlCalls()[0].query.includes('convertPullRequestToDraft'));
    assert.strictEqual(harness.getCreatedComments().length, 1);
    assert.ok(
      harness
        .getCreatedComments()[0]
        .body.includes('Referenced issue(s) not assigned to @contributor: #300.')
    );
    assert.notStrictEqual(harness.getFailedMessage(), null);
  });

  it('does not post duplicate comments when an already-draft PR is edited and still failing', async () => {
    const harness = createHarness({
      action: 'edited',
      pr: {
        number: 60,
        node_id: 'PR_60',
        draft: true,
        author_association: 'NONE',
        user: { login: 'contributor', type: 'User' },
        body: 'Still working on description',
      },
    });

    await harness.run();

    assert.strictEqual(harness.getGraphqlCalls().length, 0);
    assert.strictEqual(harness.getCreatedComments().length, 0);
    assert.notStrictEqual(harness.getFailedMessage(), null);
  });

  it('logs warning with permissions hint when GraphQL convertToDraft fails', async () => {
    const harness = createHarness({
      action: 'ready_for_review',
      pr: {
        number: 70,
        node_id: 'PR_70',
        draft: false,
        author_association: 'NONE',
        user: { login: 'contributor', type: 'User' },
        body: 'No issue linked yet',
      },
      graphqlError: new Error('Resource not accessible by integration'),
    });

    await harness.run();

    assert.strictEqual(harness.getWarningMessages().length, 1);
    assert.ok(
      harness
        .getWarningMessages()[0]
        .includes('Toggling draft state needs `contents: write` and `pull-requests: write`.')
    );
    assert.strictEqual(harness.getCreatedComments().length, 1);
  });
});
