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
import email.message
import io
import json
import subprocess
import urllib.error

import generate_test
from fakes import FakeResponse

KEY = "AIzaSECRET-test-key-0123456789"
HEADER_MARKER = "x-leaky-header-value-42"


def file_chunk(path, body_lines):
    lines = [
        f"diff --git a/{path} b/{path}\n",
        f"--- a/{path}\n",
        f"+++ b/{path}\n",
        "@@ -1 +1 @@\n",
    ] + [f"+{line}\n" for line in body_lines]
    return "".join(lines)


A = file_chunk("keras_hub/a.py", ["x = 1"] * 5)
B = file_chunk("keras_hub/b.py", ["y = 2"] * 50)
C = file_chunk("keras_hub/c.py", ["z = 3"] * 5)
DIFF = A + B + C


def ok_payload(text="```python\ndef test_ok():\n    assert True\n```"):
    return json.dumps(
        {"candidates": [{"content": {"parts": [{"text": text}]}}]}
    ).encode()


def http_error(code):
    hdrs = email.message.Message()
    hdrs["X-Debug"] = HEADER_MARKER
    return urllib.error.HTTPError(
        "https://generativelanguage.googleapis.com/x", code, "err", hdrs,
        io.BytesIO(b'{"error": "' + HEADER_MARKER.encode() + b'"}'),
    )


class Recorder:
    def __init__(self, responses):
        self.responses = list(responses)
        self.requests = []

    def __call__(self, request, timeout):
        self.requests.append(request)
        item = self.responses.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


def fake_git(diff=DIFF, calls=None):
    def run(args, env, capture_output, check):
        if calls is not None:
            calls.append((args, env))
        return subprocess.CompletedProcess(args, 0, stdout=diff.encode(), stderr=b"")

    return run


def base_env(tmp_path, **extra):
    env = {
        "GEMINI_API_KEY": KEY,
        "TARGET_DIR": "target",
        "BASE_REF": "v0.32.0",
        "HEAD_REF": "a" * 40,
        "OUTPUT_DIR": str(tmp_path / "generated"),
        "PUBLISH_VERSION": "0.33.0",
        "PACKAGES": '["keras-hub", "keras-nlp"]',
        "IMPORT_NAMES": '["keras_hub", "keras_nlp"]',
    }
    env.update(extra)
    return env


def test_truncation_keeps_whole_files_only():
    limit = len((A + C).encode())
    kept, omitted = generate_test.truncate_diff(DIFF, limit)
    assert kept == A + C
    assert omitted == ["keras_hub/b.py"]
    # Never cuts inside a file: every kept chunk is intact.
    assert generate_test.split_files(kept) == [A, C]


def test_truncation_just_below_a_boundary_drops_the_file():
    kept, omitted = generate_test.truncate_diff(A + B, len((A + B).encode()) - 1)
    assert kept == A
    assert omitted == ["keras_hub/b.py"]


def test_no_truncation_when_under_limit():
    assert generate_test.truncate_diff(DIFF, 10**9) == (DIFF, [])


def test_success_writes_file_key_only_in_header(tmp_path, capsys):
    opener = Recorder([FakeResponse(ok_payload())])
    git_calls = []
    rc = generate_test.main(
        env=base_env(tmp_path), opener=opener, sleep=lambda s: None,
        run=fake_git(calls=git_calls),
    )
    assert rc == 0
    out = (tmp_path / "generated" / "test_generated_release.py").read_text()
    assert "def test_ok" in out
    (request,) = opener.requests
    assert request.get_header("X-goog-api-key") == KEY
    assert KEY not in request.full_url
    body = request.data.decode()
    assert KEY not in body
    assert "keras_hub/a.py" in json.loads(body)["contents"][0]["parts"][0]["text"]
    captured = capsys.readouterr()
    assert KEY not in captured.out + captured.err
    # The key never reaches the git subprocess environment.
    (args, env), = git_calls
    assert "GEMINI_API_KEY" not in env
    assert KEY not in json.dumps(env)
    assert "--no-ext-diff" in args and "--no-textconv" in args
    assert "core.hooksPath=/dev/null" in args


def test_prompt_never_contains_key(tmp_path):
    prompt = generate_test.build_prompt(
        DIFF, ["x.py"], ["keras-hub"], ["keras_hub"], "0.33.0", "v0.32.0"
    )
    assert KEY not in prompt
    assert "x.py" in prompt


def test_non_200_exits_1_without_printing_headers(tmp_path, capsys):
    opener = Recorder([http_error(403)] * 3)
    rc = generate_test.main(
        env=base_env(tmp_path), opener=opener, sleep=lambda s: None,
        run=fake_git(),
    )
    assert rc == 1
    captured = capsys.readouterr()
    text = captured.out + captured.err
    assert "HTTP 403" in text
    assert HEADER_MARKER not in text
    assert KEY not in text
    assert not (tmp_path / "generated").exists()


def test_non_200_status_without_exception_also_fails(tmp_path, capsys):
    opener = Recorder([FakeResponse(b"{}", status=204)] * 3)
    rc = generate_test.main(
        env=base_env(tmp_path), opener=opener, sleep=lambda s: None,
        run=fake_git(),
    )
    assert rc == 1
    assert "HTTP 204" in capsys.readouterr().out


def test_three_attempts_with_backoff(tmp_path):
    sleeps = []
    opener = Recorder([http_error(503)] * 3)
    rc = generate_test.main(
        env=base_env(tmp_path), opener=opener, sleep=sleeps.append,
        run=fake_git(),
    )
    assert rc == 1
    assert len(opener.requests) == 3
    assert sleeps == [2, 4]


def test_retry_recovers(tmp_path):
    opener = Recorder([http_error(503), FakeResponse(ok_payload())])
    rc = generate_test.main(
        env=base_env(tmp_path), opener=opener, sleep=lambda s: None,
        run=fake_git(),
    )
    assert rc == 0
    assert len(opener.requests) == 2


def test_missing_key_exits_1(tmp_path):
    env = base_env(tmp_path)
    del env["GEMINI_API_KEY"]
    opener = Recorder([])
    assert generate_test.main(env=env, opener=opener, sleep=lambda s: None, run=fake_git()) == 1
    assert opener.requests == []


def test_uncompilable_answer_exits_1(tmp_path):
    opener = Recorder([FakeResponse(ok_payload("def broken(:\n"))])
    rc = generate_test.main(
        env=base_env(tmp_path), opener=opener, sleep=lambda s: None,
        run=fake_git(),
    )
    assert rc == 1


def test_blank_base_ref_diffs_from_empty_tree():
    args = generate_test.git_diff_args("target", "", "abc")
    assert generate_test.EMPTY_TREE in args
