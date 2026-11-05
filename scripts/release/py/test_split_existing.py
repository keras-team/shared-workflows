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
import os
import urllib.error

import pytest

import split_existing
from fakes import FakeResponse

HUB_WHL = "keras_hub-0.33.1-py3-none-any.whl"
NLP_WHL = "keras_nlp-0.33.1-py3-none-any.whl"


def pypi_payload(files):
    return json.dumps(
        {"urls": [{"filename": f, "digests": {"sha256": d}} for f, d in files.items()]}
    ).encode()


def http_error(code):
    return urllib.error.HTTPError("https://pypi.org/x", code, "err", {}, None)


def make_opener(responses, calls):
    """`responses` is a list consumed per call: bytes or an exception."""

    def opener(url, timeout):
        calls.append(url)
        item = responses.pop(0)
        if isinstance(item, Exception):
            raise item
        return FakeResponse(item)

    return opener


def test_fetch_parses_files():
    calls = []
    opener = make_opener([pypi_payload({HUB_WHL: "aa"})], calls)
    files = split_existing.fetch_release_files("keras-hub", "0.33.1", opener, sleep=lambda s: None)
    assert files == {HUB_WHL: "aa"}
    assert calls == ["https://pypi.org/pypi/keras-hub/0.33.1/json"]


def test_fetch_404_means_not_on_pypi():
    opener = make_opener([http_error(404)], [])
    assert split_existing.fetch_release_files("keras-hub", "0.33.1", opener, sleep=lambda s: None) == {}


def test_fetch_retries_then_succeeds():
    sleeps = []
    opener = make_opener([http_error(503), http_error(502), pypi_payload({})], [])
    assert split_existing.fetch_release_files("p", "1.0.0", opener, sleep=sleeps.append) == {}
    assert sleeps == [2, 4]


def test_fetch_fails_closed_after_retries():
    opener = make_opener([http_error(500)] * 3, [])
    with pytest.raises(split_existing.PypiError, match="HTTP 500"):
        split_existing.fetch_release_files("p", "1.0.0", opener, sleep=lambda s: None)


def hub_tree(root):
    for rel, name in (("dist", HUB_WHL), ("keras_nlp/dist", NLP_WHL)):
        os.makedirs(os.path.join(root, rel), exist_ok=True)
        with open(os.path.join(root, rel, name), "wb") as f:
            f.write(name.encode())


def test_partial_resume_moves_only_files_already_on_pypi(tmp_path):
    # keras-hub wheel already on PyPI, keras-nlp missing.
    root, existing = tmp_path / "a", tmp_path / "existing"
    hub_tree(root)
    pypi = {"keras-hub": {HUB_WHL: "pypi-hub"}, "keras-nlp": {}}
    manifest, dirs = split_existing.split(
        str(root), str(existing), ["dist/", "keras_nlp/dist/"],
        ["keras-hub", "keras-nlp"], "0.33.1", lambda p, v: pypi[p],
    )
    assert manifest == {
        "uploaded": [f"keras_nlp/dist/{NLP_WHL}"],
        "existing": [{"file": f"dist/{HUB_WHL}", "pypi_sha256": "pypi-hub"}],
    }
    assert dirs == ["", f"{root}/keras_nlp/dist/"]
    assert not (root / "dist" / HUB_WHL).exists()
    assert (existing / "dist" / HUB_WHL).exists()
    assert (root / "keras_nlp" / "dist" / NLP_WHL).exists()


def test_nothing_on_pypi_keeps_order_keras_hub_first(tmp_path):
    hub_tree(tmp_path)
    manifest, dirs = split_existing.split(
        str(tmp_path), str(tmp_path / "e"), ["dist/", "keras_nlp/dist/"],
        ["keras-hub", "keras-nlp"], "0.33.1", lambda p, v: {},
    )
    assert manifest["existing"] == []
    assert dirs == [f"{tmp_path}/dist/", f"{tmp_path}/keras_nlp/dist/"]


def test_single_dist_dir_pads_second_upload_dir(tmp_path):
    os.makedirs(tmp_path / "dist")
    (tmp_path / "dist" / "keras-3.0.0.tar.gz").write_bytes(b"x")
    _, dirs = split_existing.split(
        str(tmp_path), str(tmp_path / "e"), ["dist/"], ["keras"], "3.0.0",
        lambda p, v: {},
    )
    assert dirs == [f"{tmp_path}/dist/", ""]


def test_more_than_two_dist_dirs_refused(tmp_path):
    with pytest.raises(split_existing.PypiError, match="at most 2"):
        split_existing.split(str(tmp_path), "e", ["a/", "b/", "c/"], ["a", "b", "c"], "1", None)


def test_dist_dirs_and_packages_must_pair(tmp_path):
    hub_tree(tmp_path)
    with pytest.raises(split_existing.PypiError, match=r"dist_dirs\[i\] must hold packages\[i\]"):
        split_existing.split(
            str(tmp_path), str(tmp_path / "e"), ["dist/", "keras_nlp/dist/"],
            ["keras-hub"], "0.33.1", lambda p, v: {},
        )


def test_main_writes_outputs(tmp_path, monkeypatch):
    hub_tree(tmp_path / "r")
    out = tmp_path / "out"
    monkeypatch.setenv("GITHUB_OUTPUT", str(out))
    rc = split_existing.main(
        [
            "--root", str(tmp_path / "r"), "--existing-dir", str(tmp_path / "e"),
            "--dist-dirs", '["dist/", "keras_nlp/dist/"]',
            "--packages", '["keras-hub", "keras-nlp"]', "--version", "0.33.1",
        ],
        fetch=lambda p, v: {HUB_WHL: "h"} if p == "keras-hub" else {},
    )
    assert rc == 0
    lines = out.read_text().splitlines()
    manifest = json.loads(lines[0].split("=", 1)[1])
    assert manifest["uploaded"] == [f"keras_nlp/dist/{NLP_WHL}"]
    assert lines[1] == "upload_dir_0="
    assert lines[2] == f"upload_dir_1={tmp_path / 'r'}/keras_nlp/dist/"


def test_main_fails_when_pypi_unreachable(tmp_path, capsys):
    hub_tree(tmp_path)

    def fetch(p, v):
        raise split_existing.PypiError("PyPI JSON for keras-hub 0.33.1 failed: HTTP 503")

    rc = split_existing.main(
        [
            "--root", str(tmp_path), "--existing-dir", str(tmp_path / "e"),
            "--dist-dirs", '["dist/", "keras_nlp/dist/"]',
            "--packages", '["keras-hub", "keras-nlp"]', "--version", "0.33.1",
        ],
        fetch=fetch,
    )
    assert rc == 1
    assert "::error::PyPI JSON" in capsys.readouterr().out
