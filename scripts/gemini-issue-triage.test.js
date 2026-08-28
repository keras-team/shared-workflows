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
const {
  resolveTriageMode,
  applyTriage,
  buildTriageComment,
  buildCommandRegex,
  parseModelOutput,
  filterLabels,
  sanitizeSummary,
  redactSecrets,
  MAX_SUMMARY_LENGTH,
} = require('./gemini-issue-triage.js');

function createCore() {
  const outputs = {};
  const info = [];
  const warnings = [];
  let failed = null;
  return {
    core: {
      info: (m) => info.push(m),
      warning: (m) => warnings.push(m),
      setFailed: (m) => { failed = m; },
      setOutput: (k, v) => { outputs[k] = v; },
    },
    outputs,
    info,
    warnings,
    getFailed: () => failed,
  };
}

function createGithub() {
  const calls = { addLabels: [], createComment: [], update: [], reactions: [] };
  const github = {
    rest: {
      issues: {
        addLabels: async (p) => { calls.addLabels.push(p); return {}; },
        createComment: async (p) => { calls.createComment.push(p); return {}; },
        update: async (p) => { calls.update.push(p); return {}; },
      },
      reactions: {
        createForIssueComment: async (p) => { calls.reactions.push(p); return {}; },
      },
    },
  };
  return { github, calls };
}

const REPO = { owner: 'keras-team', repo: 'keras' };

function issueOpenedContext() {
  return { eventName: 'issues', repo: REPO, payload: { action: 'opened', issue: { number: 42 } } };
}

function commentContext({ body = '/issue triage', association = 'MEMBER', userType = 'User', login = 'maintainer', onPr = false } = {}) {
  const issue = { number: 42 };
  if (onPr) issue.pull_request = { url: 'x' };
  return {
    eventName: 'issue_comment',
    repo: REPO,
    payload: {
      action: 'created',
      issue,
      comment: { id: 7, body, author_association: association, user: { login, type: userType } },
    },
  };
}

// ---------------------------------------------------------------------------
describe('redactSecrets', () => {
  const cases = [
    ['Google API key', 'key AIzaSyA1234567890abcdefghijklmnopqrstuvw fails', 'AIzaSy'],
    ['GitHub classic token', 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD here', 'ghp_'],
    ['GitHub fine-grained PAT', 'github_pat_11ABCDEFG0123456789abcdefghijklmnop_xyz', 'github_pat_'],
    ['AWS access key', 'AKIAIOSFODNN7EXAMPLE', 'AKIA'],
    ['sk- style key', 'sk-abcdefghijklmnopqrstuvwxyz123456', 'sk-abc'],
    ['Slack token', 'xoxb-123456789012-abcdefghijk', 'xoxb-'],
    ['Hugging Face token', 'hf_abcdefghijklmnopqrstuvwxyz0123456789', 'hf_abc'],
    ['Bearer header', 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def', 'eyJhbG'],
    ['password assignment', 'password=hunter2secret', 'hunter2'],
    ['api_key with quotes', 'api_key: "abcdef123456"', 'abcdef123456'],
    ['email address', 'contact me at someone@example.com', 'someone@'],
    ['private key block', '-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----', 'MIIE'],
    ['long mixed blob', 'value 0123456789abcdef0123456789abcdef0123456789abcdef end', '0123456789abcdef0123456789'],
  ];
  for (const [name, input, marker] of cases) {
    it(`redacts ${name}`, () => {
      const out = redactSecrets(input);
      assert.ok(!out.includes(marker), `expected "${marker}" to be redacted from: ${out}`);
      assert.ok(out.includes('[REDACTED'), `expected a redaction marker in: ${out}`);
    });
  }

  it('leaves ordinary text and version strings alone', () => {
    const text = 'Using keras@3.6 with tensorflow 2.16 on Python 3.11, model.fit raises ValueError.';
    assert.strictEqual(redactSecrets(text), text);
  });

  it('handles non-string input', () => {
    assert.strictEqual(redactSecrets(undefined), '');
    assert.strictEqual(redactSecrets(42), '');
  });
});

// ---------------------------------------------------------------------------
describe('sanitizeSummary', () => {
  it('strips backticks, angle brackets and newlines so a code fence cannot be escaped', () => {
    const evil = '```\n## IGNORE ABOVE\n@everyone [here](https://evil.example) <img src=x onerror=alert(1)>\n```text';
    const out = sanitizeSummary(evil);
    assert.ok(!out.includes('`'));
    assert.ok(!out.includes('<') && !out.includes('>'));
    assert.ok(!out.includes('\n'));
  });

  it('redacts secrets before rendering', () => {
    const out = sanitizeSummary('The user passed AIzaSyA1234567890abcdefghijklmnopqrstuvw as the key.');
    assert.ok(out.includes('[REDACTED]'));
    assert.ok(!out.includes('AIzaSy'));
  });

  it('caps the length', () => {
    const out = sanitizeSummary('x'.repeat(MAX_SUMMARY_LENGTH + 100));
    assert.strictEqual(out.length, MAX_SUMMARY_LENGTH + 1);
    assert.ok(out.endsWith('…'));
  });

  it('falls back for empty or non-string values', () => {
    assert.strictEqual(sanitizeSummary(''), '(no summary provided)');
    assert.strictEqual(sanitizeSummary(null), '(no summary provided)');
    assert.strictEqual(sanitizeSummary({ toString: () => 'x' }), '(no summary provided)');
  });
});

// ---------------------------------------------------------------------------
describe('parseModelOutput', () => {
  const obj = { labels_to_set: ['python'], triage_reason: null };

  it('parses raw JSON', () => {
    assert.deepStrictEqual(parseModelOutput(JSON.stringify(obj)), obj);
  });

  it('parses JSON inside a ```json fence', () => {
    assert.deepStrictEqual(parseModelOutput('Sure!\n```json\n' + JSON.stringify(obj) + '\n```\n'), obj);
  });

  it('parses JSON surrounded by prose', () => {
    assert.deepStrictEqual(parseModelOutput('Here you go: ' + JSON.stringify(obj) + ' Done.'), obj);
  });

  it('returns null for garbage, arrays and non-strings', () => {
    assert.strictEqual(parseModelOutput('not json at all'), null);
    assert.strictEqual(parseModelOutput('[1,2,3]'), null);
    assert.strictEqual(parseModelOutput(undefined), null);
  });
});

// ---------------------------------------------------------------------------
describe('filterLabels', () => {
  it('keeps only allowlisted string labels', () => {
    const { labelsToAdd, blocked } = filterLabels(['python', 'admin-only', 42, 'layers'], ['python', 'layers']);
    assert.deepStrictEqual(labelsToAdd, ['python', 'layers']);
    assert.deepStrictEqual(blocked, ['admin-only']);
  });

  it('tolerates a missing or non-array value', () => {
    assert.deepStrictEqual(filterLabels(undefined, ['python']).labelsToAdd, []);
    assert.deepStrictEqual(filterLabels('python', ['python']).labelsToAdd, []);
  });
});

// ---------------------------------------------------------------------------
describe('buildCommandRegex', () => {
  const re = buildCommandRegex('/issue triage');
  it('matches the command at the start of a comment, case-insensitively, with flexible whitespace', () => {
    assert.ok(re.test('/issue triage'));
    assert.ok(re.test('/Issue   triage please'));
    assert.ok(re.test('/issue triage\nmore text'));
  });
  it('rejects near-misses', () => {
    assert.ok(!re.test('/issue triagex'));
    assert.ok(!re.test('hello /issue triage'));
    assert.ok(!re.test('/issue'));
  });
  it('escapes regex metacharacters in custom commands', () => {
    assert.ok(buildCommandRegex('/triage.now').test('/triage.now'));
    assert.ok(!buildCommandRegex('/triage.now').test('/triageXnow'));
  });
});

// ---------------------------------------------------------------------------
describe('buildTriageComment', () => {
  const base = {
    parsed: {
      issue_type: 'bug',
      triage_reason: 'needs_info',
      has_reproduction: false,
      confidence: 'high',
      summary: 'Model crashes on fit.',
    },
    labelsToAdd: ['backend:jax'],
    relatedFiles: ['keras/src/core.py'],
    triggerLogin: 'maintainer',
    model: 'gemini-3.5-flash',
    command: '/issue triage',
    autoClose: false,
  };

  it('renders enum fields, labels, files and the summary in a code block', () => {
    const out = buildTriageComment(base);
    assert.ok(out.includes('| Issue type | Bug report |'));
    assert.ok(out.includes('| Classification | Needs more information |'));
    assert.ok(out.includes('| Reproduction provided | No |'));
    assert.ok(out.includes('| Confidence | High |'));
    assert.ok(out.includes('`backend:jax`'));
    assert.ok(out.includes('`keras/src/core.py`'));
    assert.ok(out.includes('```text\nModel crashes on fit.\n```'));
    assert.ok(out.includes('**Recommended action:** Ask the author for a minimal reproducible example'));
    assert.ok(out.includes('requested by @maintainer'));
    assert.ok(!out.includes('Action taken'));
  });

  it('falls back to fixed strings for unknown, prototype or missing enum values', () => {
    const out = buildTriageComment({
      ...base,
      parsed: { issue_type: '__proto__', triage_reason: 'constructor', confidence: 'very high', summary: 42 },
    });
    assert.ok(out.includes('| Issue type | Unclassified |'));
    assert.ok(out.includes('| Classification | Valid bug report or feature request |'));
    assert.ok(out.includes('| Confidence | Unknown |'));
    assert.ok(out.includes('**Recommended action:** Needs maintainer review and investigation.'));
    assert.ok(out.includes('(no summary provided)'));
  });

  it('confines model text to a single fenced code block it cannot escape', () => {
    const injected = '```\n@everyone click [here](https://evil.example)\n<script>alert(1)</script>\n```';
    const out = buildTriageComment({ ...base, parsed: { ...base.parsed, summary: injected } });

    // Exactly one fenced block: the model text cannot open or close another.
    const fenceCount = (out.match(/```/g) || []).length;
    assert.strictEqual(fenceCount, 2, 'exactly one opening and one closing fence');

    // Inside the fence markdown/HTML/@mentions are inert, but confirm there is
    // no raw HTML and nothing multi-line (a fence break-out needs a newline).
    const [before, rest] = out.split('```text\n');
    const [inside, after] = rest.split('\n```');
    assert.ok(!inside.includes('\n'));
    assert.ok(!inside.includes('`'));
    assert.ok(!inside.includes('<') && !inside.includes('>'));

    // Nothing model-derived appears outside the fence, where it would render.
    for (const fragment of ['evil.example', '@everyone', 'script', 'alert']) {
      assert.ok(!before.includes(fragment), `"${fragment}" leaked before the fence`);
      assert.ok(!after.includes(fragment), `"${fragment}" leaked after the fence`);
    }
  });

  it('drops unsafe file paths and unsafe logins', () => {
    const out = buildTriageComment({
      ...base,
      relatedFiles: ['ok/path.py', 'bad path](http://x)', '<b>x</b>'],
      triggerLogin: 'evil](http://x)',
    });
    assert.ok(out.includes('`ok/path.py`'));
    assert.ok(!out.includes('http://x'));
    assert.ok(out.includes('requested by a maintainer'));
  });

  it('mentions the auto-close action when closing', () => {
    const out = buildTriageComment({ ...base, autoClose: true });
    assert.ok(out.includes('**Action taken:** issue closed as not planned'));
  });
});

// ---------------------------------------------------------------------------
describe('resolveTriageMode', () => {
  it('uses label-only mode for issue events', async () => {
    const { core, outputs } = createCore();
    const { github, calls } = createGithub();
    const result = await resolveTriageMode({ github, context: issueOpenedContext(), core, env: {} });
    assert.strictEqual(result.mode, 'labels');
    assert.strictEqual(result.issueNumber, 42);
    assert.strictEqual(outputs.mode, 'labels');
    assert.strictEqual(outputs.issue_number, '42');
    assert.strictEqual(calls.reactions.length, 0);
  });

  it('prefers an explicit issue_number input', async () => {
    const { core } = createCore();
    const { github } = createGithub();
    const result = await resolveTriageMode({ github, context: issueOpenedContext(), core, env: { INPUT_ISSUE_NUMBER: '99' } });
    assert.strictEqual(result.issueNumber, 99);
  });

  it('fails when no issue number can be resolved', async () => {
    const { core, getFailed } = createCore();
    const { github } = createGithub();
    const result = await resolveTriageMode({ github, context: { eventName: 'issues', repo: REPO, payload: {} }, core, env: {} });
    assert.strictEqual(result.mode, 'skip');
    assert.match(getFailed(), /Could not determine issue number/);
  });

  it('posts a summary for a team member using the trigger command and reacts to the comment', async () => {
    const { core, outputs } = createCore();
    const { github, calls } = createGithub();
    const result = await resolveTriageMode({ github, context: commentContext(), core, env: {} });
    assert.strictEqual(result.mode, 'summary');
    assert.strictEqual(result.triggerLogin, 'maintainer');
    assert.strictEqual(outputs.trigger_login, 'maintainer');
    assert.strictEqual(calls.reactions.length, 1);
    assert.strictEqual(calls.reactions[0].comment_id, 7);
    assert.strictEqual(calls.reactions[0].content, 'eyes');
  });

  it('skips comments that do not start with the trigger command', async () => {
    const { core } = createCore();
    const { github, calls } = createGithub();
    const result = await resolveTriageMode({ github, context: commentContext({ body: 'Thanks! Also /issue triage' }), core, env: {} });
    assert.strictEqual(result.mode, 'skip');
    assert.strictEqual(calls.reactions.length, 0);
  });

  it('skips the trigger command from non-team members', async () => {
    const { core, info } = createCore();
    const { github, calls } = createGithub();
    for (const association of ['NONE', 'CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', '']) {
      const result = await resolveTriageMode({ github, context: commentContext({ association, login: 'outsider' }), core, env: {} });
      assert.strictEqual(result.mode, 'skip', `association ${association}`);
    }
    assert.strictEqual(calls.reactions.length, 0);
    assert.ok(info.some(m => m.includes('outsider is not authorized')));
  });

  it('skips comments on pull requests and from bots', async () => {
    const { core } = createCore();
    const { github } = createGithub();
    assert.strictEqual((await resolveTriageMode({ github, context: commentContext({ onPr: true }), core, env: {} })).mode, 'skip');
    assert.strictEqual((await resolveTriageMode({ github, context: commentContext({ userType: 'Bot' }), core, env: {} })).mode, 'skip');
  });

  it('honours a custom allowed_associations list', async () => {
    const { core } = createCore();
    const { github } = createGithub();
    const env = { ALLOWED_ASSOCIATIONS: 'OWNER' };
    assert.strictEqual((await resolveTriageMode({ github, context: commentContext({ association: 'MEMBER' }), core, env })).mode, 'skip');
    assert.strictEqual((await resolveTriageMode({ github, context: commentContext({ association: 'owner' }), core, env })).mode, 'summary');
  });

  it('authorizes via org team membership when configured', async () => {
    const { core } = createCore();
    const { github } = createGithub();
    const requests = [];
    const fetchImpl = async (url, opts) => {
      requests.push({ url, opts });
      return { ok: true, status: 200, json: async () => ({ state: 'active' }) };
    };
    const env = { TRIAGE_TEAM: 'keras-eng', ORG_READ_TOKEN: 'tok', API_URL: 'https://api.github.com' };
    const result = await resolveTriageMode({ github, context: commentContext({ association: 'NONE', login: 'teammate' }), core, env, fetchImpl });
    assert.strictEqual(result.mode, 'summary');
    assert.strictEqual(requests.length, 1);
    assert.strictEqual(requests[0].url, 'https://api.github.com/orgs/keras-team/teams/keras-eng/memberships/teammate');
    assert.strictEqual(requests[0].opts.headers.Authorization, 'Bearer tok');
  });

  it('denies when team membership is missing or pending', async () => {
    const { core } = createCore();
    const { github } = createGithub();
    const env = { TRIAGE_TEAM: 'keras-eng', ORG_READ_TOKEN: 'tok' };
    const notFound = async () => ({ ok: false, status: 404 });
    const pending = async () => ({ ok: true, status: 200, json: async () => ({ state: 'pending' }) });
    const ctx = () => commentContext({ association: 'NONE', login: 'stranger' });
    assert.strictEqual((await resolveTriageMode({ github, context: ctx(), core, env, fetchImpl: notFound })).mode, 'skip');
    assert.strictEqual((await resolveTriageMode({ github, context: ctx(), core, env, fetchImpl: pending })).mode, 'skip');
  });

  it('warns and denies when triage_team is set without a token', async () => {
    const { core, warnings } = createCore();
    const { github } = createGithub();
    let fetched = false;
    const fetchImpl = async () => { fetched = true; return { ok: true, json: async () => ({ state: 'active' }) }; };
    const result = await resolveTriageMode({ github, context: commentContext({ association: 'NONE' }), core, env: { TRIAGE_TEAM: 'keras-eng' }, fetchImpl });
    assert.strictEqual(result.mode, 'skip');
    assert.strictEqual(fetched, false);
    assert.ok(warnings.some(w => w.includes('ORG_READ_TOKEN')));
  });
});

// ---------------------------------------------------------------------------
describe('applyTriage', () => {
  const modelOutput = (extra = {}) => JSON.stringify({
    labels_to_set: ['python', 'not-allowed'],
    issue_type: 'question',
    triage_reason: 'user_error',
    has_reproduction: false,
    confidence: 'high',
    summary: 'User called fit() with mismatched shapes. Key AIzaSyA1234567890abcdefghijklmnopqrstuvw was pasted.',
    auto_close: true,
    ...extra,
  });

  const baseEnv = (extra = {}) => ({
    MODE: 'labels',
    ISSUE_NUMBER: '42',
    MODEL_OUTPUT: modelOutput(),
    ALLOWED_LABELS: 'python, layers',
    RELATED_FILES: '["keras/src/a.py"]',
    GEMINI_MODEL: 'gemini-3.5-flash',
    TRIGGER_COMMAND: '/issue triage',
    TRIGGER_LOGIN: 'maintainer',
    ENABLE_AUTO_CLOSE: 'true',
    ...extra,
  });

  it('in labels mode adds allowlisted labels only and never comments or closes', async () => {
    const { core, warnings } = createCore();
    const { github, calls } = createGithub();
    const result = await applyTriage({ github, context: { repo: REPO }, core, env: baseEnv() });
    assert.deepStrictEqual(result, { labelsToAdd: ['python'], commented: false, closed: false });
    assert.strictEqual(calls.addLabels.length, 1);
    assert.deepStrictEqual(calls.addLabels[0].labels, ['python']);
    assert.strictEqual(calls.addLabels[0].issue_number, 42);
    assert.strictEqual(calls.createComment.length, 0);
    assert.strictEqual(calls.update.length, 0);
    assert.ok(warnings.some(w => w.includes('not-allowed')));
  });

  it('in summary mode posts the templated comment with secrets redacted', async () => {
    const { core } = createCore();
    const { github, calls } = createGithub();
    const result = await applyTriage({ github, context: { repo: REPO }, core, env: baseEnv({ MODE: 'summary', ENABLE_AUTO_CLOSE: 'false' }) });
    assert.deepStrictEqual(result, { labelsToAdd: ['python'], commented: true, closed: false });
    assert.strictEqual(calls.createComment.length, 1);
    const body = calls.createComment[0].body;
    assert.ok(body.startsWith('## 🔎 Issue Triage Summary'));
    assert.ok(body.includes('| Issue type | Question |'));
    assert.ok(body.includes('`python`'));
    assert.ok(body.includes('`keras/src/a.py`'));
    assert.ok(body.includes('[REDACTED]'));
    assert.ok(!body.includes('AIzaSy'));
    assert.strictEqual(calls.update.length, 0);
  });

  it('auto-closes only in summary mode with auto-close enabled and a user_error classification', async () => {
    const run = async (env) => {
      const { core } = createCore();
      const { github, calls } = createGithub();
      await applyTriage({ github, context: { repo: REPO }, core, env: baseEnv(env) });
      return calls;
    };
    let calls = await run({ MODE: 'summary', ENABLE_AUTO_CLOSE: 'true' });
    assert.strictEqual(calls.update.length, 1);
    assert.strictEqual(calls.update[0].state, 'closed');
    assert.strictEqual(calls.update[0].state_reason, 'not_planned');
    assert.ok(calls.createComment[0].body.includes('**Action taken:** issue closed'));

    calls = await run({ MODE: 'labels', ENABLE_AUTO_CLOSE: 'true' });
    assert.strictEqual(calls.update.length, 0);

    calls = await run({ MODE: 'summary', ENABLE_AUTO_CLOSE: 'false' });
    assert.strictEqual(calls.update.length, 0);

    calls = await run({ MODE: 'summary', ENABLE_AUTO_CLOSE: 'true', MODEL_OUTPUT: modelOutput({ triage_reason: 'needs_info' }) });
    assert.strictEqual(calls.update.length, 0);

    calls = await run({ MODE: 'summary', ENABLE_AUTO_CLOSE: 'true', MODEL_OUTPUT: modelOutput({ auto_close: 'true' }) });
    assert.strictEqual(calls.update.length, 0, 'auto_close must be boolean true');
  });

  it('fails cleanly on unparsable model output without touching the issue', async () => {
    const { core, getFailed } = createCore();
    const { github, calls } = createGithub();
    const result = await applyTriage({ github, context: { repo: REPO }, core, env: baseEnv({ MODE: 'summary', MODEL_OUTPUT: 'I cannot help with that.' }) });
    assert.deepStrictEqual(result, { labelsToAdd: [], commented: false, closed: false });
    assert.match(getFailed(), /Invalid model JSON output/);
    assert.strictEqual(calls.addLabels.length, 0);
    assert.strictEqual(calls.createComment.length, 0);
  });

  it('tolerates malformed RELATED_FILES', async () => {
    const { core } = createCore();
    const { github, calls } = createGithub();
    await applyTriage({ github, context: { repo: REPO }, core, env: baseEnv({ MODE: 'summary', RELATED_FILES: 'not json' }) });
    assert.ok(calls.createComment[0].body.includes('_none found_'));
  });
});
