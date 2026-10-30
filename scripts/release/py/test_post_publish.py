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
import json

import post_publish
import split_existing

HUB = "dist/keras_hub-0.33.1-py3-none-any.whl"
NLP = "keras_nlp/dist/keras_nlp-0.33.1-py3-none-any.whl"
HUB_NAME = HUB.rsplit("/", 1)[1]
NLP_NAME = NLP.rsplit("/", 1)[1]

# Resume after a partial upload: keras-hub was uploaded by an earlier run
# (its rebuilt copy differs), keras-nlp is uploaded now.
RESUME_MANIFEST = {
    "uploaded": [NLP],
    "existing": [{"file": HUB, "pypi_sha256": "hub-from-earlier-run"}],
}
DIGESTS = {HUB: "hub-rebuilt-differs", NLP: "nlp-built"}


class FakeClock:
    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now

    def sleep(self, s):
        self.now += s


def fetch_from(files_by_package):
    return lambda p, v: dict(files_by_package.get(p, {}))


def run(manifest, digests, pypi, install=lambda p, v: True, timeout=60):
    clock = FakeClock()
    return post_publish.run_check(
        manifest, digests, ["keras-hub", "keras-nlp"], "0.33.1",
        fetch=fetch_from(pypi), install=install, timeout=timeout, interval=10,
        clock=clock, sleep=clock.sleep,
    )


def test_resume_digest_scope_only_compares_this_runs_uploads():
    pypi = {
        "keras-hub": {HUB_NAME: "hub-from-earlier-run"},
        "keras-nlp": {NLP_NAME: "nlp-built"},
    }
    rows, ok, _ = run(RESUME_MANIFEST, DIGESTS, pypi)
    assert ok
    assert ("✅", NLP, "uploaded by this run", "nlp-built", "nlp-built") in rows
    assert ("✅", HUB, "published by an earlier run", "", "hub-from-earlier-run") in rows


def test_mismatch_on_uploaded_file_fails_and_renders_cross():
    pypi = {
        "keras-hub": {HUB_NAME: "hub-from-earlier-run"},
        "keras-nlp": {NLP_NAME: "tampered"},
    }
    rows, ok, message = run(RESUME_MANIFEST, DIGESTS, pypi)
    assert not ok
    assert "do not match" in message
    assert ("❌", NLP, "sha256 mismatch", "nlp-built", "tampered") in rows
    assert "| ❌ |" in post_publish.render(rows, "0.33.1")


def test_times_out_when_a_file_never_appears():
    pypi = {"keras-hub": {HUB_NAME: "hub-from-earlier-run"}, "keras-nlp": {}}
    rows, ok, message = run(RESUME_MANIFEST, DIGESTS, pypi)
    assert not ok
    assert "timeout" in message
    assert ("❌", NLP, "not on PyPI", "nlp-built", "") in rows


def test_waits_for_install_before_comparing():
    pypi = {
        "keras-hub": {HUB_NAME: "hub-from-earlier-run"},
        "keras-nlp": {NLP_NAME: "nlp-built"},
    }
    attempts = []

    def install(packages, version):
        attempts.append(list(packages))
        return len(attempts) >= 3

    _, ok, _ = run(RESUME_MANIFEST, DIGESTS, pypi, install=install)
    assert ok
    assert attempts == [["keras-hub", "keras-nlp"]] * 3


def test_install_never_succeeds_fails():
    pypi = {
        "keras-hub": {HUB_NAME: "hub-from-earlier-run"},
        "keras-nlp": {NLP_NAME: "nlp-built"},
    }
    _, ok, message = run(RESUME_MANIFEST, DIGESTS, pypi, install=lambda p, v: False)
    assert not ok and "timeout" in message


def test_pypi_errors_are_retried_by_the_poll():
    calls = []

    def fetch(p, v):
        calls.append(p)
        if len(calls) <= 2:
            raise split_existing.PypiError("HTTP 503")
        return {HUB_NAME: "h", NLP_NAME: "n"}

    clock = FakeClock()
    _, ok, _ = post_publish.run_check(
        {"uploaded": [HUB, NLP], "existing": []}, {HUB: "h", NLP: "n"},
        ["keras-hub", "keras-nlp"], "0.33.1", fetch=fetch,
        install=lambda p, v: True, timeout=60, interval=10, clock=clock,
        sleep=clock.sleep,
    )
    assert ok


def test_poll_stops_at_deadline():
    clock = FakeClock()
    calls = []
    assert not post_publish.poll(lambda: calls.append(1) or False, 1200, 30, clock, clock.sleep)
    assert clock.now <= 1200
    assert len(calls) == 41


def test_main_writes_summary_and_exit_code(tmp_path, monkeypatch):
    summary = tmp_path / "summary.md"
    monkeypatch.setenv("GITHUB_STEP_SUMMARY", str(summary))
    clock = FakeClock()
    rc = post_publish.main(
        [
            "--manifest", json.dumps({"uploaded": [HUB], "existing": []}),
            "--digests", json.dumps({HUB: "h"}),
            "--packages", '["keras-hub"]', "--version", "0.33.1",
        ],
        fetch=lambda p, v: {HUB_NAME: "other"}, install=lambda p, v: True,
        timeout=10, interval=5, clock=clock, sleep=clock.sleep,
    )
    assert rc == 1
    assert "| ❌ |" in summary.read_text()
