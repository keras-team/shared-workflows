# Copyright 2026 The Keras Authors. All Rights Reserved.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ==============================================================================
"""Generate release tests with Gemini (publish.yml `generate`).

Stdlib only; run as `python -I sw/scripts/release/py/generate_test.py` from
outside the target checkout. Diffs the target repo between the previous
release tag and the release commit (git with `--no-ext-diff --no-textconv`
and hooks off, so the target's .gitattributes cannot run anything), truncates
the diff at file boundaries, and asks Gemini for a pytest file.

The API key is sent only in the `x-goog-api-key` header: never in the prompt,
the URL, a log line, or the git subprocess environment. A non-200 response
exits 1 after 3 attempts with backoff, printing only the status code.

Environment:
  GEMINI_API_KEY   required
  TARGET_DIR       target checkout (full history and tags)
  BASE_REF         previous release tag; empty = diff the whole tree
  HEAD_REF         release commit sha
  OUTPUT_DIR       where test_generated_release.py is written
  PUBLISH_VERSION  version being released
  PACKAGES         JSON list of PyPI names
  IMPORT_NAMES     JSON list of import names
  GEMINI_MODEL     optional, default below
  MAX_DIFF_BYTES   optional, default below
"""

import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

API_URL = (
    "https://generativelanguage.googleapis.com/v1beta/models/"
    "{model}:generateContent"
)
DEFAULT_MODEL = "gemini-2.5-pro"
DEFAULT_MAX_DIFF_BYTES = 400_000
ATTEMPTS = 3
EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
OUTPUT_FILE = "test_generated_release.py"


class GenerationError(Exception):
    pass


def git_env(env):
    """Environment for git: the API key never reaches a subprocess."""
    clean = {k: v for k, v in env.items() if k != "GEMINI_API_KEY"}
    clean["GIT_CONFIG_NOSYSTEM"] = "1"
    clean["GIT_TERMINAL_PROMPT"] = "0"
    return clean


def git_diff_args(target_dir, base_ref, head_ref):
    return [
        "git", "-C", target_dir, "-c", "core.hooksPath=/dev/null",
        "diff", "--no-ext-diff", "--no-textconv", "--no-color",
        base_ref or EMPTY_TREE, head_ref, "--",
    ]


def run_git_diff(target_dir, base_ref, head_ref, env, run=subprocess.run):
    result = run(
        git_diff_args(target_dir, base_ref, head_ref),
        env=git_env(env), capture_output=True, check=False,
    )
    if result.returncode != 0:
        raise GenerationError(f"git diff failed with exit {result.returncode}")
    return result.stdout.decode("utf-8", errors="replace")


def split_files(diff):
    """Splits a unified git diff into one chunk per file."""
    chunks, current = [], []
    for line in diff.splitlines(keepends=True):
        if line.startswith("diff --git ") and current:
            chunks.append("".join(current))
            current = []
        current.append(line)
    if current:
        chunks.append("".join(current))
    return chunks


def chunk_path(chunk):
    m = re.match(r"diff --git a/(\S+) b/", chunk)
    return m.group(1) if m else chunk.split("\n", 1)[0]


def truncate_diff(diff, max_bytes):
    """Keeps whole files only. Returns (kept_text, omitted_paths)."""
    kept, omitted, size = [], [], 0
    for chunk in split_files(diff):
        n = len(chunk.encode("utf-8"))
        if size + n <= max_bytes:
            kept.append(chunk)
            size += n
        else:
            omitted.append(chunk_path(chunk))
    return "".join(kept), omitted


def build_prompt(diff, omitted, packages, import_names, version, base_ref):
    omitted_note = ""
    if omitted:
        omitted_note = (
            "\nThese changed files were left out of the diff for size: "
            + ", ".join(omitted) + "\n"
        )
    base = base_ref or "the empty tree (first release)"
    return (
        "You write pytest tests for a Python library release.\n"
        f"Packages being released (PyPI): {', '.join(packages)}; version "
        f"{version}.\n"
        f"Import names: {', '.join(import_names)}.\n"
        f"Below is the git diff from {base} to the release commit."
        f"{omitted_note}\n"
        "Write ONE self-contained pytest file that checks behaviour changed or "
        "added in this diff through the public API of the installed packages. "
        "Rules: import only the packages above, pytest, numpy and the Python "
        "standard library; no network access; write files only under pytest's "
        "tmp_path; keep every test small and fast on CPU; the tests must pass "
        "with KERAS_BACKEND set to tensorflow, jax or torch; do not download "
        "presets or weights. Reply with only the Python source, no prose.\n\n"
        "```diff\n" + diff + "```\n"
    )


def extract_code(text):
    m = re.search(r"```(?:python)?\s*\n(.*?)```", text, flags=re.S)
    return (m.group(1) if m else text).strip() + "\n"


def call_gemini(prompt, api_key, model, opener=urllib.request.urlopen,
                sleep=time.sleep):
    url = API_URL.format(model=urllib.parse.quote(model, safe=""))
    body = json.dumps(
        {"contents": [{"role": "user", "parts": [{"text": prompt}]}]}
    ).encode("utf-8")
    last = None
    for attempt in range(ATTEMPTS):
        if attempt:
            sleep(2 ** attempt)
        request = urllib.request.Request(url, data=body, method="POST")
        request.add_header("Content-Type", "application/json")
        request.add_header("x-goog-api-key", api_key)
        try:
            with opener(request, timeout=300) as resp:
                status = resp.status
                payload = resp.read()
            if status == 200:
                return json.loads(payload.decode("utf-8"))
            last = f"HTTP {status}"
        except urllib.error.HTTPError as e:
            # Only the status code: never headers or the request.
            last = f"HTTP {e.code}"
        except (urllib.error.URLError, OSError) as e:
            last = type(e).__name__
        print(f"Gemini attempt {attempt + 1}/{ATTEMPTS} failed: {last}")
    raise GenerationError(f"Gemini request failed after {ATTEMPTS} attempts: {last}")


def response_text(data):
    try:
        parts = data["candidates"][0]["content"]["parts"]
    except (KeyError, IndexError, TypeError):
        raise GenerationError("Gemini returned no candidates")
    text = "".join(p.get("text", "") for p in parts if isinstance(p, dict))
    if not text.strip():
        raise GenerationError("Gemini returned an empty answer")
    return text


def main(env=None, opener=urllib.request.urlopen, sleep=time.sleep,
         run=subprocess.run):
    env = dict(os.environ if env is None else env)
    try:
        api_key = env.get("GEMINI_API_KEY", "")
        if not api_key:
            raise GenerationError("GEMINI_API_KEY is not set")
        for name in ("TARGET_DIR", "HEAD_REF", "OUTPUT_DIR", "PUBLISH_VERSION",
                     "PACKAGES", "IMPORT_NAMES"):
            if not env.get(name):
                raise GenerationError(f"{name} is not set")
        max_bytes = int(env.get("MAX_DIFF_BYTES") or DEFAULT_MAX_DIFF_BYTES)
        base_ref = env.get("BASE_REF", "")
        diff = run_git_diff(env["TARGET_DIR"], base_ref, env["HEAD_REF"], env,
                            run=run)
        kept, omitted = truncate_diff(diff, max_bytes)
        print(f"Diff: {len(kept.encode('utf-8'))} bytes kept, "
              f"{len(omitted)} files omitted for size")
        prompt = build_prompt(
            kept, omitted, json.loads(env["PACKAGES"]),
            json.loads(env["IMPORT_NAMES"]), env["PUBLISH_VERSION"], base_ref,
        )
        data = call_gemini(prompt, api_key,
                           env.get("GEMINI_MODEL") or DEFAULT_MODEL,
                           opener=opener, sleep=sleep)
        code = extract_code(response_text(data))
        try:
            compile(code, OUTPUT_FILE, "exec")
        except SyntaxError as e:
            raise GenerationError(f"generated code does not compile: line {e.lineno}")
        os.makedirs(env["OUTPUT_DIR"], exist_ok=True)
        path = os.path.join(env["OUTPUT_DIR"], OUTPUT_FILE)
        with open(path, "w", encoding="utf-8") as f:
            f.write(code)
        print(f"Wrote {path} ({len(code.splitlines())} lines)")
        return 0
    except GenerationError as e:
        print(f"::error::{e}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
