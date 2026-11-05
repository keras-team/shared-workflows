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
 * A refusal is an expected, user-facing stop: the release tool decided not to
 * act. Its message is shown verbatim in the run summary, followed by a
 * "Next:" line telling the user what to do.
 */

const DEFAULT_NEXT = "fix the problem above and run the panel again.";

class RefusalError extends Error {
  /**
   * @param {string} message What was refused and why.
   * @param {string} [next] What the user should do next.
   */
  constructor(message, next) {
    super(message);
    this.name = "RefusalError";
    this.next = next && String(next).trim() ? String(next).trim() : DEFAULT_NEXT;
  }
}

/**
 * Renders any thrown value for the run summary. Refusals end with their
 * "Next:" line; anything else is an unexpected failure.
 */
function formatRefusal(err) {
  if (err instanceof RefusalError) {
    return `${err.message}\n\nNext: ${err.next}`;
  }
  const message = err && err.message ? err.message : String(err);
  return (
    `Unexpected error: ${message}\n\n` +
    "Next: this is a bug in the release tool; open an issue on " +
    "keras-team/shared-workflows with a link to this run."
  );
}

/** Predicate (e.g. for assert.throws): a RefusalError whose message matches `re`. */
function refusalMatching(re) {
  return (e) => e instanceof RefusalError && re.test(e.message);
}

module.exports = { RefusalError, formatRefusal, refusalMatching, DEFAULT_NEXT };
