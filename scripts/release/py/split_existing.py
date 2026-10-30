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
"""Move files already on PyPI out of the upload dirs (publish.yml `upload`).

Stdlib only and safe under `python -I`. Runs before the PyPA upload steps.
For each `packages[i]` it reads the PyPI JSON for the version; files of
`dist_dirs[i]` already listed there are moved to `--existing-dir` and
recorded as "existing" with PyPI's sha256; the rest are "uploaded". Only the
"uploaded" files are digest-checked by post_publish.py: builds are not
byte-reproducible, so a resume's rebuilt copy of an earlier upload never
matches. `skip-existing` stays on in the PyPA step as a race backstop.

Writes to $GITHUB_OUTPUT:
  manifest      {"uploaded": [key, ...], "existing": [{"file", "pypi_sha256"}]}
  upload_dir_0  artifact path of dist_dirs[0] if it still has files, else ""
  upload_dir_1  same for dist_dirs[1]
"""

import argparse
import json
import os
import shutil
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

PYPI_JSON = "https://pypi.org/pypi/{package}/{version}/json"
MAX_DIST_DIRS = 2  # publish.yml has one PyPA upload step per dist dir.
RETRIES = 3


class PypiError(Exception):
    pass


def fetch_release_files(
    package, version, opener=urllib.request.urlopen, sleep=time.sleep
):
    """Returns {filename: sha256} for `package==version` on PyPI.

    404 means the version is not on PyPI yet and returns {}. Other failures
    are retried with backoff and then raise PypiError: never guess.
    """
    url = PYPI_JSON.format(
        package=urllib.parse.quote(package, safe=""),
        version=urllib.parse.quote(version, safe=""),
    )
    last = None
    for attempt in range(RETRIES):
        if attempt:
            sleep(2 ** attempt)
        try:
            with opener(url, timeout=30) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            return {
                f["filename"]: f["digests"]["sha256"]
                for f in data.get("urls", [])
            }
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return {}
            last = f"HTTP {e.code}"
        except (urllib.error.URLError, OSError, ValueError, KeyError) as e:
            last = type(e).__name__
    raise PypiError(f"PyPI JSON for {package} {version} failed: {last}")


def split(root, existing_dir, dist_dirs, packages, version, fetch):
    if len(dist_dirs) > MAX_DIST_DIRS:
        raise PypiError(
            f"{len(dist_dirs)} dist_dirs configured; publish.yml uploads at "
            f"most {MAX_DIST_DIRS}"
        )
    if len(dist_dirs) != len(packages):
        raise PypiError("dist_dirs[i] must hold packages[i]")
    uploaded, existing, upload_dirs = [], [], []
    for dist_dir, package in zip(dist_dirs, packages):
        rel = dist_dir.strip("/")
        on_pypi = fetch(package, version)
        src_dir = os.path.join(root, rel)
        remaining = 0
        for name in sorted(os.listdir(src_dir)):
            key = f"{rel}/{name}"
            if name in on_pypi:
                dest = os.path.join(existing_dir, rel)
                os.makedirs(dest, exist_ok=True)
                shutil.move(os.path.join(src_dir, name), os.path.join(dest, name))
                existing.append({"file": key, "pypi_sha256": on_pypi[name]})
            else:
                uploaded.append(key)
                remaining += 1
        upload_dirs.append(src_dir + "/" if remaining else "")
    while len(upload_dirs) < MAX_DIST_DIRS:
        upload_dirs.append("")
    return {"uploaded": uploaded, "existing": existing}, upload_dirs


def main(argv=None, fetch=fetch_release_files):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True)
    parser.add_argument("--existing-dir", required=True)
    parser.add_argument("--dist-dirs", required=True, help="JSON list")
    parser.add_argument("--packages", required=True, help="JSON list")
    parser.add_argument("--version", required=True)
    args = parser.parse_args(argv)
    try:
        manifest, upload_dirs = split(
            args.root, args.existing_dir, json.loads(args.dist_dirs),
            json.loads(args.packages), args.version, fetch,
        )
    except PypiError as e:
        print(f"::error::{e}")
        return 1
    for item in manifest["existing"]:
        print(f"Already on PyPI (published by an earlier run): {item['file']}")
    for key in manifest["uploaded"]:
        print(f"To upload: {key}")
    output = os.environ.get("GITHUB_OUTPUT")
    if output:
        with open(output, "a", encoding="utf-8") as f:
            f.write("manifest=" + json.dumps(manifest, sort_keys=True) + "\n")
            for i, d in enumerate(upload_dirs):
                f.write(f"upload_dir_{i}={d}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
