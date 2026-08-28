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

/**
 * Logic for the reusable Gemini issue triage workflow.
 *
 * Two modes:
 *   - 'labels'  (default, e.g. `issues: opened`): apply allowlisted labels only.
 *   - 'summary' (a team member comments the trigger command): apply labels and
 *     post a triage summary rendered from a fixed template.
 *
 * Everything the model produces is either mapped through a closed enum table
 * or sanitized (secrets redacted, markdown stripped) and rendered inside a
 * fenced code block, so model output cannot inject links, HTML, or mentions.
 */

const DEFAULT_TRIGGER_COMMAND = '/issue triage';
const DEFAULT_ALLOWED_ASSOCIATIONS = 'OWNER,MEMBER,COLLABORATOR';
const MAX_SUMMARY_LENGTH = 600;
const NO_SUMMARY = '(no summary provided)';

const ISSUE_TYPES = {
  bug: 'Bug report',
  feature_request: 'Feature request',
  question: 'Question',
  documentation: 'Documentation',
  other: 'Other',
};

const TRIAGE_REASONS = {
  user_error: 'User error / no code change needed',
  needs_info: 'Needs more information',
  support: 'Support question',
};

const RECOMMENDED_ACTIONS = {
  user_error: 'Close as not planned; no change to the repository is required.',
  needs_info: 'Ask the author for a minimal reproducible example and environment details.',
  support: 'Redirect to the discussion forum or Discord; this is not a bug report or feature request.',
};

const CONFIDENCE = { low: 'Low', medium: 'Medium', high: 'High' };

const DEFAULT_ISSUE_TYPE = 'Unclassified';
const DEFAULT_CLASSIFICATION = 'Valid bug report or feature request';
const DEFAULT_ACTION = 'Needs maintainer review and investigation.';
const DEFAULT_CONFIDENCE = 'Unknown';

// Patterns for credentials that must never be echoed into a comment (or sent
// on to the model). Order matters: multi-line and specific patterns first, the
// generic high-entropy catch-all last.
const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]'],
  [/AIza[0-9A-Za-z_-]{35}/g, '[REDACTED]'],                        // Google API key
  [/gh[pousr]_[A-Za-z0-9]{36,}/g, '[REDACTED]'],                   // GitHub tokens
  [/github_pat_[A-Za-z0-9_]{22,}/g, '[REDACTED]'],                 // GitHub fine-grained PAT
  [/AKIA[0-9A-Z]{16}/g, '[REDACTED]'],                             // AWS access key id
  [/sk-[A-Za-z0-9_-]{20,}/g, '[REDACTED]'],                        // OpenAI / Anthropic-style keys
  [/xox[abprs]-[A-Za-z0-9-]{10,}/g, '[REDACTED]'],                 // Slack tokens
  [/\bhf_[A-Za-z0-9]{30,}/g, '[REDACTED]'],                        // Hugging Face tokens
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g, 'Bearer [REDACTED]'],
  [/\b(api[_-]?key|secret[_-]?key|secret|access[_-]?token|auth[_-]?token|token|password|passwd|pwd|authorization)\b(\s*[:=]\s*)["']?[^\s"',;]{6,}["']?/gi, '$1$2[REDACTED]'],
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,}/g, '[REDACTED EMAIL]'],
  [/\b(?=[A-Za-z0-9+/_-]*\d)(?=[A-Za-z0-9+/_-]*[A-Za-z])[A-Za-z0-9+/_-]{40,}\b/g, '[REDACTED]'], // long mixed alnum blobs
];

/**
 * Replaces anything that looks like a credential with a redaction marker.
 * @param {*} text
 * @return {string}
 */
function redactSecrets(text) {
  if (typeof text !== 'string' || text === '') return '';
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/**
 * Turns the free-text model summary into a single line of plain text that is
 * safe to place inside a fenced code block: secrets redacted, backticks/HTML
 * angle brackets removed, control characters collapsed, length capped.
 * @param {*} value
 * @return {string}
 */
function sanitizeSummary(value) {
  if (typeof value !== 'string') return NO_SUMMARY;
  let text = redactSecrets(value)
    .replace(/[`<>]/g, '')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length > MAX_SUMMARY_LENGTH) {
    text = text.slice(0, MAX_SUMMARY_LENGTH).trimEnd() + '…';
  }
  return text || NO_SUMMARY;
}

/**
 * Parses the raw model output as JSON, tolerating a ```json fence or
 * surrounding prose. Returns null if no JSON object can be recovered.
 * @param {*} rawOutput
 * @return {?object}
 */
function parseModelOutput(rawOutput) {
  if (typeof rawOutput !== 'string') return null;
  const candidates = [rawOutput];
  const fenced = rawOutput.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenced && fenced[1]) candidates.push(fenced[1]);
  const braced = rawOutput.match(/(\{[\s\S]*"labels_to_set"[\s\S]*\})/);
  if (braced && braced[1]) candidates.push(braced[1]);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate.trim());
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch (e) {
      // try next candidate
    }
  }
  return null;
}

/**
 * Keeps only labels that appear verbatim in the allowlist.
 * @param {*} requested
 * @param {!Array<string>} allowed
 * @return {{labelsToAdd: !Array<string>, blocked: !Array<string>}}
 */
function filterLabels(requested, allowed) {
  const requestedLabels = Array.isArray(requested) ? requested.filter(l => typeof l === 'string') : [];
  const labelsToAdd = requestedLabels.filter(label => allowed.includes(label));
  const blocked = requestedLabels.filter(label => !allowed.includes(label));
  return { labelsToAdd, blocked };
}

function parseList(raw, transform = s => s) {
  return (raw || '').split(',').map(s => transform(s.trim())).filter(Boolean);
}

function pick(value, table, fallback) {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(table, value)
    ? table[value]
    : fallback;
}

function inlineCode(value) {
  return '`' + String(value).replace(/[`\n\r]/g, '') + '`';
}

const SAFE_PATH = /^[\w./-]+$/;
const SAFE_LOGIN = /^[A-Za-z0-9-]+$/;

/**
 * Builds a regex that matches a comment beginning with the trigger command
 * (case-insensitive, flexible internal whitespace, must be a whole word).
 * @param {string} command
 * @return {!RegExp}
 */
function buildCommandRegex(command) {
  const trimmed = (command || DEFAULT_TRIGGER_COMMAND).trim();
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp('^' + escaped + '(\\s|$)', 'i');
}

/**
 * Renders the triage summary comment from a fixed template.
 * @param {!object} params
 * @param {!object} params.parsed - Parsed model output.
 * @param {!Array<string>} params.labelsToAdd - Labels that were applied.
 * @param {!Array<string>} params.relatedFiles - File paths from the codebase search.
 * @param {string} params.triggerLogin - Login of the team member who triggered triage.
 * @param {string} params.model - Model name, for the footer.
 * @param {string} params.command - Trigger command, for the footer.
 * @param {boolean} params.autoClose - Whether the issue is being auto-closed.
 * @return {string}
 */
function buildTriageComment({ parsed, labelsToAdd, relatedFiles, triggerLogin, model, command, autoClose }) {
  const triageReason = typeof parsed.triage_reason === 'string' ? parsed.triage_reason : null;
  const issueType = pick(parsed.issue_type, ISSUE_TYPES, DEFAULT_ISSUE_TYPE);
  const classification = pick(triageReason, TRIAGE_REASONS, DEFAULT_CLASSIFICATION);
  const recommendedAction = pick(triageReason, RECOMMENDED_ACTIONS, DEFAULT_ACTION);
  const confidence = pick(parsed.confidence, CONFIDENCE, DEFAULT_CONFIDENCE);
  const hasRepro = parsed.has_reproduction === true ? 'Yes' : 'No';
  const summary = sanitizeSummary(parsed.summary);

  const safeFiles = (Array.isArray(relatedFiles) ? relatedFiles : [])
    .filter(f => typeof f === 'string' && SAFE_PATH.test(f));
  const requestedBy = SAFE_LOGIN.test(triggerLogin || '') ? `@${triggerLogin}` : 'a maintainer';

  const lines = [
    '## 🔎 Issue Triage Summary',
    '',
    `> Automated triage requested by ${requestedBy}. The classification and summary below were generated by an AI model from the issue text and may be inaccurate; please verify before acting.`,
    '',
    '| Field | Value |',
    '| --- | --- |',
    `| Issue type | ${issueType} |`,
    `| Classification | ${classification} |`,
    `| Reproduction provided | ${hasRepro} |`,
    `| Confidence | ${confidence} |`,
    `| Labels applied | ${labelsToAdd.length ? labelsToAdd.map(inlineCode).join(', ') : '_none_'} |`,
    `| Possibly related files | ${safeFiles.length ? safeFiles.map(inlineCode).join(', ') : '_none found_'} |`,
    '',
    '**Summary (model output, rendered verbatim)**',
    '',
    '```text',
    summary,
    '```',
    '',
    `**Recommended action:** ${recommendedAction}`,
  ];
  if (autoClose) {
    lines.push('', '**Action taken:** issue closed as not planned (auto-close is enabled for user-error classifications).');
  }
  lines.push('', `<sub>Model: ${inlineCode(model || 'unknown')} · Command: ${inlineCode(command || DEFAULT_TRIGGER_COMMAND)}</sub>`);
  return lines.join('\n');
}

/**
 * Gate step: resolves the issue number and decides the run mode.
 *
 * Env: INPUT_ISSUE_NUMBER, TRIGGER_COMMAND, ALLOWED_ASSOCIATIONS, TRIAGE_TEAM,
 *      ORG_READ_TOKEN, API_URL.
 * Outputs: mode ('labels' | 'summary' | 'skip'), issue_number, trigger_login.
 *
 * @param {!object} params
 * @param {!object} params.github - GitHub octokit client.
 * @param {!object} params.context - GitHub actions context.
 * @param {!object} params.core - Actions core library.
 * @param {!object=} params.env - Environment (defaults to process.env).
 * @param {!Function=} params.fetchImpl - fetch implementation (for the team check).
 * @return {!Promise<{mode: string, issueNumber: ?number, triggerLogin: string}>}
 */
async function resolveTriageMode({ github, context, core, env = process.env, fetchImpl = globalThis.fetch }) {
  const emit = (result) => {
    core.setOutput('mode', result.mode);
    core.setOutput('issue_number', result.issueNumber ? String(result.issueNumber) : '');
    core.setOutput('trigger_login', result.triggerLogin || '');
    return result;
  };
  const skip = (reason) => {
    core.info(`Skipping: ${reason}`);
    return emit({ mode: 'skip', issueNumber: null, triggerLogin: '' });
  };

  // Resolve the issue number from inputs or the event payload.
  let issueNumber = null;
  const inputNum = env.INPUT_ISSUE_NUMBER;
  if (inputNum && inputNum !== '0' && inputNum.trim() !== '') {
    issueNumber = parseInt(inputNum.trim(), 10);
  } else if (context.payload.inputs && context.payload.inputs.issue_number) {
    issueNumber = parseInt(context.payload.inputs.issue_number, 10);
  } else if (context.payload.issue && context.payload.issue.number) {
    issueNumber = context.payload.issue.number;
  }
  if (!issueNumber || isNaN(issueNumber)) {
    core.setFailed('Could not determine issue number from event or inputs.');
    return emit({ mode: 'skip', issueNumber: null, triggerLogin: '' });
  }

  // Default mode: label only.
  if (context.eventName !== 'issue_comment') {
    return emit({ mode: 'labels', issueNumber, triggerLogin: '' });
  }

  // Comment mode: only act on the trigger command from a human on an issue.
  const comment = context.payload.comment || {};
  const issue = context.payload.issue || {};
  if (issue.pull_request) return skip('comment is on a pull request');
  if (!comment.user || comment.user.type === 'Bot') return skip('comment author is a bot');

  const command = env.TRIGGER_COMMAND || DEFAULT_TRIGGER_COMMAND;
  if (!buildCommandRegex(command).test((comment.body || '').trim())) {
    return skip('comment does not start with the trigger command');
  }

  // Authorization: association allowlist, then optional org team membership.
  const login = comment.user.login || '';
  const association = (comment.author_association || '').toUpperCase();
  const allowedAssociations = parseList(env.ALLOWED_ASSOCIATIONS || DEFAULT_ALLOWED_ASSOCIATIONS, s => s.toUpperCase());
  let authorized = allowedAssociations.includes(association);
  core.info(`Commenter ${login} has association ${association}; allowed by association: ${authorized}`);

  const team = (env.TRIAGE_TEAM || '').trim();
  if (!authorized && team) {
    const token = env.ORG_READ_TOKEN;
    if (!token) {
      core.warning('triage_team is set but ORG_READ_TOKEN secret was not provided; skipping team check.');
    } else {
      const apiUrl = env.API_URL || 'https://api.github.com';
      const url = `${apiUrl}/orgs/${encodeURIComponent(context.repo.owner)}/teams/${encodeURIComponent(team)}/memberships/${encodeURIComponent(login)}`;
      try {
        const res = await fetchImpl(url, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
        });
        if (res.ok) {
          const membership = await res.json();
          authorized = membership.state === 'active';
        } else {
          core.info(`Team membership lookup returned HTTP ${res.status}`);
        }
      } catch (e) {
        core.warning(`Team membership lookup failed: ${e.message}`);
      }
      core.info(`Allowed by team "${team}": ${authorized}`);
    }
  }

  if (!authorized) return skip(`${login} is not authorized to request a triage summary`);

  // Acknowledge the request on the triggering comment.
  try {
    await github.rest.reactions.createForIssueComment({
      owner: context.repo.owner,
      repo: context.repo.repo,
      comment_id: comment.id,
      content: 'eyes',
    });
  } catch (e) {
    core.warning(`Could not add reaction: ${e.message}`);
  }

  return emit({ mode: 'summary', issueNumber, triggerLogin: login });
}

/**
 * Final step: applies allowlisted labels and, in summary mode, posts the
 * templated comment (and optionally auto-closes).
 *
 * Env: MODE, TRIGGER_LOGIN, TRIGGER_COMMAND, GEMINI_MODEL, ISSUE_NUMBER,
 *      MODEL_OUTPUT, ALLOWED_LABELS, RELATED_FILES (JSON array), ENABLE_AUTO_CLOSE.
 *
 * @param {!object} params
 * @param {!object} params.github - GitHub octokit client.
 * @param {!object} params.context - GitHub actions context.
 * @param {!object} params.core - Actions core library.
 * @param {!object=} params.env - Environment (defaults to process.env).
 * @return {!Promise<{labelsToAdd: !Array<string>, commented: boolean, closed: boolean}>}
 */
async function applyTriage({ github, context, core, env = process.env }) {
  const mode = env.MODE;
  const allowedLabels = parseList(env.ALLOWED_LABELS);
  const enableAutoClose = env.ENABLE_AUTO_CLOSE === 'true';
  const issueNumber = parseInt(env.ISSUE_NUMBER, 10);
  const result = { labelsToAdd: [], commented: false, closed: false };

  core.info(`Mode: ${mode}`);
  core.info(`Raw output from model: ${env.MODEL_OUTPUT}`);
  core.info(`Allowed labels: ${allowedLabels.join(', ')}`);

  const parsed = parseModelOutput(env.MODEL_OUTPUT);
  if (!parsed) {
    core.setFailed(`Invalid model JSON output: ${env.MODEL_OUTPUT}`);
    return result;
  }

  // 1. Strict label allowlist (prevents unauthorized label manipulation).
  const { labelsToAdd, blocked } = filterLabels(parsed.labels_to_set, allowedLabels);
  result.labelsToAdd = labelsToAdd;
  if (blocked.length > 0) {
    core.warning(`Blocked unauthorized labels: ${blocked.join(', ')}`);
  }
  if (labelsToAdd.length > 0) {
    await github.rest.issues.addLabels({
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: issueNumber,
      labels: labelsToAdd,
    });
    core.info(`Added labels to #${issueNumber}: ${labelsToAdd.join(', ')}`);
  } else {
    core.info(`No allowed labels to add to #${issueNumber}.`);
  }

  // 2. Default mode stops here: labels only, never a comment.
  if (mode !== 'summary') {
    core.info('Label-only mode: no comment posted.');
    return result;
  }

  // 3. Restricted auto-close (summary mode + enabled + user_error only).
  const autoClose = enableAutoClose && parsed.auto_close === true && parsed.triage_reason === 'user_error';

  let relatedFiles = [];
  try { relatedFiles = JSON.parse(env.RELATED_FILES || '[]'); } catch (e) { relatedFiles = []; }

  const body = buildTriageComment({
    parsed,
    labelsToAdd,
    relatedFiles,
    triggerLogin: env.TRIGGER_LOGIN || '',
    model: env.GEMINI_MODEL,
    command: env.TRIGGER_COMMAND,
    autoClose,
  });

  await github.rest.issues.createComment({
    owner: context.repo.owner,
    repo: context.repo.repo,
    issue_number: issueNumber,
    body,
  });
  result.commented = true;
  core.info(`Posted triage summary to #${issueNumber}`);

  if (autoClose) {
    await github.rest.issues.update({
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: issueNumber,
      state: 'closed',
      state_reason: 'not_planned',
    });
    result.closed = true;
    core.info(`Auto-closed issue #${issueNumber} as not_planned.`);
  }

  return result;
}

module.exports = {
  resolveTriageMode,
  applyTriage,
  buildTriageComment,
  buildCommandRegex,
  parseModelOutput,
  filterLabels,
  sanitizeSummary,
  redactSecrets,
  MAX_SUMMARY_LENGTH,
};
