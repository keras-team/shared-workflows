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
"""Validate the dist artifact before the PyPI upload (publish.yml `upload`).

Stdlib only and safe under `python -I`. Reads wheel METADATA and sdist
PKG-INFO with zipfile / tarfile; never executes or extracts target code.

Two modes:

  digests   Every file in `dist_dirs` must appear in the build job's
            sha256 map with the same digest, and every mapped file must exist.
  metadata  Every file must be a `.whl` or `.tar.gz`; `dist_dirs[i]` holds
            only `packages[i]` (so the upload order follows `packages`, i.e.
            keras-hub first); filename name/version and METADATA/PKG-INFO
            Name/Version must agree with each other, with the configured
            package, and Version must equal the tag's version.
"""

import argparse
import email.parser
import hashlib
import json
import os
import re
import sys
import tarfile
import zipfile

MAX_METADATA_BYTES = 1024 * 1024


def normalize(name):
    """PEP 503 normalized project name."""
    return re.sub(r"[-_.]+", "-", name).lower()


def rel_key(dist_dir, name):
    """Key used by the build job's digest map, e.g. `keras_nlp/dist/x.whl`."""
    return f"{dist_dir.strip('/')}/{name}"


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def list_dir(root, dist_dir):
    path = os.path.join(root, dist_dir.strip("/"))
    if not os.path.isdir(path):
        return None
    return sorted(os.listdir(path))


def check_digests(root, dist_dirs, expected):
    errors = []
    seen = set()
    for dist_dir in dist_dirs:
        names = list_dir(root, dist_dir)
        if names is None:
            errors.append(f"{dist_dir}: directory missing from the artifact")
            continue
        for name in names:
            key = rel_key(dist_dir, name)
            seen.add(key)
            path = os.path.join(root, key)
            if key not in expected:
                errors.append(f"{key}: not produced by the build job")
                continue
            if not os.path.isfile(path):
                errors.append(f"{key}: not a regular file")
                continue
            actual = sha256_file(path)
            if actual != expected[key]:
                errors.append(
                    f"{key}: sha256 {actual} != build job's {expected[key]}"
                )
    for key in sorted(set(expected) - seen):
        errors.append(f"{key}: recorded by the build job but missing now")
    return errors


def parse_wheel_filename(filename):
    """`{name}-{ver}(-{build})?-{py}-{abi}-{plat}.whl` -> (name, version)."""
    stem = filename[: -len(".whl")]
    parts = stem.split("-")
    if len(parts) not in (5, 6):
        raise ValueError(f"{filename}: not a valid wheel filename")
    return parts[0], parts[1]


def parse_sdist_filename(filename):
    """`{name}-{version}.tar.gz` -> (name, version).

    Accepts the PEP 625 normalized form (`keras_hub-0.33.0.tar.gz`) and the
    legacy hyphenated one; names are compared after normalization.
    """
    stem = filename[: -len(".tar.gz")]
    if "-" not in stem:
        raise ValueError(f"{filename}: not a valid sdist filename")
    name, version = stem.rsplit("-", 1)
    if not name or not version:
        raise ValueError(f"{filename}: not a valid sdist filename")
    return name, version


def _parse_headers(raw):
    msg = email.parser.BytesHeaderParser().parsebytes(raw)
    return msg.get("Name"), msg.get("Version")


def read_wheel_metadata(path):
    with zipfile.ZipFile(path) as zf:
        members = [
            n for n in zf.namelist()
            if re.fullmatch(r"[^/]+\.dist-info/METADATA", n)
        ]
        if len(members) != 1:
            raise ValueError(
                f"expected exactly one *.dist-info/METADATA, found "
                f"{len(members)}"
            )
        info = zf.getinfo(members[0])
        if info.file_size > MAX_METADATA_BYTES:
            raise ValueError("METADATA is too large")
        return _parse_headers(zf.read(info))


def read_sdist_metadata(path):
    with tarfile.open(path, mode="r:gz") as tf:
        members = [
            m for m in tf.getmembers()
            if re.fullmatch(r"[^/]+/PKG-INFO", m.name)
        ]
        if len(members) != 1:
            raise ValueError(
                f"expected exactly one top-level PKG-INFO, found "
                f"{len(members)}"
            )
        member = members[0]
        if not member.isfile():
            raise ValueError("PKG-INFO is not a regular file")
        if member.size > MAX_METADATA_BYTES:
            raise ValueError("PKG-INFO is too large")
        f = tf.extractfile(member)
        return _parse_headers(f.read())


def check_file(path, filename, package, version):
    """Returns a list of error strings for one dist file."""
    if filename.endswith(".whl"):
        parse_name, read_meta = parse_wheel_filename, read_wheel_metadata
    elif filename.endswith(".tar.gz"):
        parse_name, read_meta = parse_sdist_filename, read_sdist_metadata
    else:
        return [f"{filename}: only .whl and .tar.gz files may be uploaded"]
    if not os.path.isfile(path) or os.path.islink(path):
        return [f"{filename}: not a regular file"]
    try:
        file_name, file_version = parse_name(filename)
        meta_name, meta_version = read_meta(path)
    except (ValueError, zipfile.BadZipFile, tarfile.TarError, OSError) as e:
        return [f"{filename}: {e}"]
    errors = []
    if not meta_name or not meta_version:
        return [f"{filename}: metadata lacks Name or Version"]
    if normalize(file_name) != normalize(package):
        errors.append(
            f"{filename}: filename names {file_name!r}, expected {package!r}"
        )
    if normalize(meta_name) != normalize(package):
        errors.append(
            f"{filename}: metadata Name {meta_name!r}, expected {package!r}"
        )
    if file_version != meta_version:
        errors.append(
            f"{filename}: filename version {file_version!r} != metadata "
            f"Version {meta_version!r}"
        )
    if meta_version != version:
        errors.append(
            f"{filename}: metadata Version {meta_version!r} != tag version "
            f"{version!r}"
        )
    return errors


def check_metadata(root, dist_dirs, packages, tag, tag_prefix):
    if not tag.startswith(tag_prefix) or len(tag) == len(tag_prefix):
        return [f"tag {tag!r} does not start with prefix {tag_prefix!r}"]
    version = tag[len(tag_prefix):]
    if len(dist_dirs) != len(packages):
        return [
            f"config has {len(dist_dirs)} dist_dirs but {len(packages)} "
            "packages; dist_dirs[i] must hold packages[i]"
        ]
    errors = []
    for dist_dir, package in zip(dist_dirs, packages):
        names = list_dir(root, dist_dir)
        if names is None:
            errors.append(f"{dist_dir}: directory missing from the artifact")
            continue
        if not names:
            errors.append(f"{dist_dir}: no files to upload")
            continue
        for name in names:
            path = os.path.join(root, dist_dir.strip("/"), name)
            errors.extend(
                f"{dist_dir.strip('/')}/{e}"
                for e in check_file(path, name, package, version)
            )
    return errors


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["digests", "metadata"])
    parser.add_argument("--root", required=True)
    parser.add_argument("--dist-dirs", required=True, help="JSON list")
    parser.add_argument("--digests", help="JSON map from the build job")
    parser.add_argument("--packages", help="JSON list")
    parser.add_argument("--tag")
    parser.add_argument("--tag-prefix")
    args = parser.parse_args(argv)
    dist_dirs = json.loads(args.dist_dirs)
    if args.mode == "digests":
        if not args.digests:
            parser.error("--digests is required in digests mode")
        errors = check_digests(args.root, dist_dirs, json.loads(args.digests))
    else:
        if not args.packages or not args.tag or args.tag_prefix is None:
            parser.error("--packages, --tag and --tag-prefix are required")
        errors = check_metadata(
            args.root, dist_dirs, json.loads(args.packages), args.tag,
            args.tag_prefix,
        )
    for e in errors:
        print(f"::error::{e}")
    if errors:
        return 1
    print(f"{args.mode}: OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
