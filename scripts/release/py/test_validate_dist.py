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
import hashlib
import io
import json
import os
import tarfile
import zipfile

import pytest

import validate_dist

HUB_DIRS = ["dist/", "keras_nlp/dist/"]
HUB_PACKAGES = ["keras-hub", "keras-nlp"]


def metadata(name, version):
    return f"Metadata-Version: 2.1\nName: {name}\nVersion: {version}\n\n".encode()


def write_wheel(path, name, version, meta_name=None, meta_version=None):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    dist = name.replace("-", "_")
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr(
            f"{dist}-{version}.dist-info/METADATA",
            metadata(meta_name or name, meta_version or version),
        )
        zf.writestr(f"{dist}/__init__.py", "")


def write_sdist(path, top, name, version):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with tarfile.open(path, "w:gz") as tf:
        data = metadata(name, version)
        info = tarfile.TarInfo(f"{top}/PKG-INFO")
        info.size = len(data)
        tf.addfile(info, io.BytesIO(data))
        egg = metadata(name, version)
        info = tarfile.TarInfo(f"{top}/{name}.egg-info/PKG-INFO")
        info.size = len(egg)
        tf.addfile(info, io.BytesIO(egg))


def hub_tree(root, version="0.33.0"):
    write_wheel(
        os.path.join(root, "dist", f"keras_hub-{version}-py3-none-any.whl"),
        "keras-hub", version,
    )
    # PEP 625 normalized sdist name.
    write_sdist(
        os.path.join(root, "dist", f"keras_hub-{version}.tar.gz"),
        f"keras_hub-{version}", "keras-hub", version,
    )
    write_wheel(
        os.path.join(
            root, "keras_nlp", "dist", f"keras_nlp-{version}-py3-none-any.whl"
        ),
        "keras-nlp", version,
    )


def check(root, packages=HUB_PACKAGES, dirs=HUB_DIRS, tag="v0.33.0"):
    return validate_dist.check_metadata(str(root), dirs, packages, tag, "v")


def test_valid_keras_hub_tree_with_pep625_sdist_passes(tmp_path):
    hub_tree(tmp_path)
    assert check(tmp_path) == []


def test_legacy_hyphenated_sdist_name_accepted(tmp_path):
    hub_tree(tmp_path)
    os.remove(tmp_path / "dist" / "keras_hub-0.33.0.tar.gz")
    write_sdist(
        str(tmp_path / "dist" / "keras-hub-0.33.0.tar.gz"),
        "keras-hub-0.33.0", "keras-hub", "0.33.0",
    )
    assert check(tmp_path) == []


def test_keras_rs_filename_with_keras_metadata_rejected(tmp_path):
    write_wheel(
        str(tmp_path / "dist" / "keras_rs-0.3.0-py3-none-any.whl"),
        "keras-rs", "0.3.0", meta_name="keras",
    )
    errors = check(tmp_path, packages=["keras-rs"], dirs=["dist/"], tag="v0.3.0")
    assert any("metadata Name 'keras'" in e for e in errors), errors


def test_stray_file_rejected(tmp_path):
    hub_tree(tmp_path)
    (tmp_path / "dist" / "notes.txt").write_text("hi")
    errors = check(tmp_path)
    assert errors == ["dist/notes.txt: only .whl and .tar.gz files may be uploaded"]


def test_zip_sdist_rejected(tmp_path):
    hub_tree(tmp_path)
    (tmp_path / "dist" / "keras_hub-0.33.0.zip").write_bytes(b"PK")
    assert any(".zip" in e for e in check(tmp_path))


def test_version_must_equal_tag(tmp_path):
    hub_tree(tmp_path, version="0.33.1")
    errors = check(tmp_path, tag="v0.33.0")
    assert errors and all("!= tag version '0.33.0'" in e for e in errors), errors


def test_filename_version_must_match_metadata(tmp_path):
    hub_tree(tmp_path)
    write_wheel(
        str(tmp_path / "dist" / "keras_hub-0.33.0-py3-none-any.whl"),
        "keras-hub", "0.33.0", meta_version="0.33.0.dev1",
    )
    errors = check(tmp_path)
    assert any("filename version '0.33.0' != metadata" in e for e in errors)


def test_package_in_wrong_dist_dir_rejected(tmp_path):
    hub_tree(tmp_path)
    write_wheel(
        str(tmp_path / "dist" / "keras_nlp-0.33.0-py3-none-any.whl"),
        "keras-nlp", "0.33.0",
    )
    errors = check(tmp_path)
    assert any("expected 'keras-hub'" in e for e in errors), errors


def test_empty_or_missing_dist_dir_rejected(tmp_path):
    hub_tree(tmp_path)
    for f in os.listdir(tmp_path / "keras_nlp" / "dist"):
        os.remove(tmp_path / "keras_nlp" / "dist" / f)
    assert check(tmp_path) == ["keras_nlp/dist/: no files to upload"]
    os.rmdir(tmp_path / "keras_nlp" / "dist")
    assert "missing" in check(tmp_path)[0]


def test_dist_dirs_and_packages_must_pair(tmp_path):
    hub_tree(tmp_path)
    assert "dist_dirs[i] must hold packages[i]" in check(
        tmp_path, packages=["keras-hub"]
    )[0]


def test_tag_without_prefix_rejected(tmp_path):
    hub_tree(tmp_path)
    assert "prefix" in check(tmp_path, tag="0.33.0")[0]


def test_wheel_without_metadata_rejected(tmp_path):
    path = tmp_path / "dist" / "keras_hub-0.33.0-py3-none-any.whl"
    os.makedirs(path.parent)
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr("keras_hub/__init__.py", "")
    errors = check(tmp_path, packages=["keras-hub"], dirs=["dist/"])
    assert any("METADATA" in e for e in errors)


def digests_of(root):
    out = {}
    for d in HUB_DIRS:
        rel = d.strip("/")
        for name in os.listdir(os.path.join(root, rel)):
            with open(os.path.join(root, rel, name), "rb") as f:
                out[f"{rel}/{name}"] = hashlib.sha256(f.read()).hexdigest()
    return out


def test_digests_match(tmp_path):
    hub_tree(tmp_path)
    assert validate_dist.check_digests(str(tmp_path), HUB_DIRS, digests_of(tmp_path)) == []


def test_digest_mismatch_extra_and_missing_files_rejected(tmp_path):
    hub_tree(tmp_path)
    expected = digests_of(tmp_path)
    key = "dist/keras_hub-0.33.0-py3-none-any.whl"
    expected[key] = "0" * 64
    expected["dist/gone.whl"] = "1" * 64
    (tmp_path / "dist" / "extra.whl").write_bytes(b"x")
    errors = validate_dist.check_digests(str(tmp_path), HUB_DIRS, expected)
    assert any(e.startswith(f"{key}: sha256") for e in errors)
    assert "dist/extra.whl: not produced by the build job" in errors
    assert "dist/gone.whl: recorded by the build job but missing now" in errors


def test_main_exit_codes(tmp_path, capsys):
    hub_tree(tmp_path)
    args = [
        "metadata", "--root", str(tmp_path), "--dist-dirs", json.dumps(HUB_DIRS),
        "--packages", json.dumps(HUB_PACKAGES), "--tag", "v0.33.0",
        "--tag-prefix", "v",
    ]
    assert validate_dist.main(args) == 0
    (tmp_path / "dist" / "stray.json").write_text("{}")
    assert validate_dist.main(args) == 1
    assert "::error::dist/stray.json" in capsys.readouterr().out


@pytest.mark.parametrize(
    "name,expected",
    [
        ("keras_hub-0.33.0-py3-none-any.whl", ("keras_hub", "0.33.0")),
        ("keras_hub-0.33.0-1-py3-none-any.whl", ("keras_hub", "0.33.0")),
    ],
)
def test_parse_wheel_filename(name, expected):
    assert validate_dist.parse_wheel_filename(name) == expected


def test_parse_wheel_filename_rejects_garbage():
    with pytest.raises(ValueError):
        validate_dist.parse_wheel_filename("keras_hub.whl")
