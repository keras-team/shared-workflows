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

const DEFAULT_TERMS = [
  'I am a human, and not a bot.',
  'I will be responsible for responding to review comments in a timely manner.',
  'I will work with the maintainers to push this PR forward until submission.'
];

/**
 * Verifies that the PR contributor agreement has been checked by external contributors,
 * while exempting repository maintainers, organization members, and bots.
 *
 * @param {!object} params
 * @param {!object} params.github - GitHub octokit client.
 * @param {!object} params.context - GitHub actions context.
 * @param {!object} params.core - Actions core library for logging and failures.
 */
module.exports = async function verifyPrContributorTerms({ github, context, core }) {
  const prNumber = context.payload.pull_request
    ? context.payload.pull_request.number
    : (context.payload.issue ? context.payload.issue.number : context.issue?.number);

  const { data: pr } = await github.rest.pulls.get({
    owner: context.repo.owner,
    repo: context.repo.repo,
    pull_number: prNumber,
  });

  const authorAssociation = (pr.author_association || '').toUpperCase();
  const authorLogin = (pr.user && pr.user.login ? pr.user.login : '').toLowerCase();
  const authorType = pr.user && pr.user.type ? pr.user.type : '';

  core.info(`PR #${prNumber} author: ${authorLogin} (type: ${authorType}, association: ${authorAssociation})`);

  // Check if author is an exempt user or bot.
  const rawExemptUsers = process.env.EXEMPT_USERS || '';
  const exemptUsers = rawExemptUsers
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);

  if (exemptUsers.includes(authorLogin) || authorType === 'Bot' || authorLogin.endsWith('[bot]')) {
    core.info(`PR author '${authorLogin}' is exempt from contributor terms check.`);
    return;
  }

  // Check if author association is exempt.
  const rawExemptAssociations = process.env.EXEMPT_ASSOCIATIONS || 'OWNER,MEMBER,COLLABORATOR';
  const exemptAssociations = rawExemptAssociations
    .split(',')
    .map(s => s.trim().toUpperCase())
    .filter(Boolean);

  if (exemptAssociations.includes(authorAssociation)) {
    core.info(`PR author association '${authorAssociation}' is exempt from contributor terms check.`);
    return;
  }

  // Determine required terms.
  const rawTerms = process.env.REQUIRED_TERMS || '';
  const customTerms = rawTerms
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean);

  const requiredTerms = customTerms.length > 0 ? customTerms : DEFAULT_TERMS;
  const body = pr.body || '';

  const unchecked = [];
  for (const term of requiredTerms) {
    // Check that the checkbox is checked: [x] or [X] with bullet list prefix (- or *).
    const escapedTerm = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const checkedPattern = new RegExp(`[-*]\\s*\\[\\s*[xX]\\s*\\]\\s*${escapedTerm}`);
    if (!checkedPattern.test(body)) {
      unchecked.push(term);
    }
  }

  if (unchecked.length > 0) {
    core.setFailed(
      `The following contributor agreement terms have not been accepted:\n` +
      unchecked.map(t => `  - ${t}`).join('\n') +
      `\n\nPlease check all boxes in the Contributor Agreement section of the PR description.`
    );
  } else {
    core.info('All contributor agreement terms accepted.');
  }
};
