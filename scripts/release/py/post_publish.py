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
"""Post-publish check (publish.yml `post-publish`).

Stdlib only and safe under `python -I`. Polls PyPI (up to 20 minutes) until
an exact-pin install of every package works and every expected file is listed
in the PyPI JSON for the version. Then, for each file THIS run uploaded, the
PyPI sha256 must equal the build job's sha256. Files set aside as already on
PyPI are listed as "published by an earlier run" with their PyPI digest and
are not compared (builds are not byte-reproducible). Writes a table to
$GITHUB_STEP_SUMMARY; a mismatch renders ❌ and fails the job.
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile
import time

# `python -I` does not put this script's directory on sys.path; add it
# explicitly so the sibling module from the same trusted checkout is found.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from split_existing import PypiError  # noqa: E402
from split_existing import fetch_release_files  # noqa: E402

TIMEOUT_SECONDS = 20 * 60
INTERVAL_SECONDS = 30


def compare(manifest, digests, pypi_files):
    """Returns (rows, ok). `pypi_files` maps filename -> sha256."""
    rows, ok = [], True
    for key in manifest["uploaded"]:
        name = key.rsplit("/", 1)[-1]
        built = digests.get(key)
        on_pypi = pypi_files.get(name)
        if built is None:
            rows.append(("❌", key, "missing from the build digests", "", ""))
            ok = False
        elif on_pypi is None:
            rows.append(("❌", key, "not on PyPI", built, ""))
            ok = False
        elif on_pypi != built:
            rows.append(("❌", key, "sha256 mismatch", built, on_pypi))
            ok = False
        else:
            rows.append(("✅", key, "uploaded by this run", built, on_pypi))
    for item in manifest["existing"]:
        name = item["file"].rsplit("/", 1)[-1]
        on_pypi = pypi_files.get(name)
        if on_pypi is None:
            rows.append(("❌", item["file"], "no longer on PyPI", "", ""))
            ok = False
        else:
            rows.append(
                ("✅", item["file"], "published by an earlier run", "", on_pypi)
            )
    return rows, ok


def expected_names(manifest):
    names = [k.rsplit("/", 1)[-1] for k in manifest["uploaded"]]
    names += [i["file"].rsplit("/", 1)[-1] for i in manifest["existing"]]
    return names


def pypi_files_for(packages, version, fetch):
    files = {}
    for package in packages:
        files.update(fetch(package, version))
    return files


def pip_install_ok(packages, version, run=subprocess.run):
    """Exact-pin install into a throwaway venv; True when pip succeeds."""
    with tempfile.TemporaryDirectory() as tmp:
        venv = os.path.join(tmp, "venv")
        subprocess.run([sys.executable, "-m", "venv", venv], check=True)
        pins = [f"{p}=={version}" for p in packages]
        result = run(
            [
                os.path.join(venv, "bin", "python"), "-m", "pip", "install",
                "--no-deps", "--no-cache-dir",
                "--index-url", "https://pypi.org/simple", *pins,
            ],
            check=False,
        )
        return result.returncode == 0


def poll(ready, timeout, interval, clock=time.monotonic, sleep=time.sleep):
    """Calls `ready()` until it returns True or `timeout` seconds pass."""
    deadline = clock() + timeout
    while True:
        if ready():
            return True
        if clock() + interval > deadline:
            return False
        sleep(interval)


def render(rows, version):
    lines = [
        f"## PyPI check for {version}",
        "",
        "| | File | Status | Build sha256 | PyPI sha256 |",
        "| --- | --- | --- | --- | --- |",
    ]
    for mark, key, status, built, on_pypi in rows:
        lines.append(f"| {mark} | `{key}` | {status} | `{built}` | `{on_pypi}` |")
    return "\n".join(lines) + "\n"


def run_check(
    manifest, digests, packages, version, fetch=fetch_release_files,
    install=pip_install_ok, timeout=TIMEOUT_SECONDS,
    interval=INTERVAL_SECONDS, clock=time.monotonic, sleep=time.sleep,
):
    """Returns (rows, ok, message)."""
    wanted = expected_names(manifest)
    state = {}

    def ready():
        try:
            files = pypi_files_for(packages, version, fetch)
        except PypiError as e:
            print(f"PyPI JSON not ready: {e}")
            return False
        state["files"] = files
        missing = [n for n in wanted if n not in files]
        if missing:
            print(f"Waiting for PyPI to list: {', '.join(missing)}")
            return False
        if not install(packages, version):
            print("Waiting for an exact-pin install to succeed")
            return False
        return True

    if not poll(ready, timeout, interval, clock, sleep):
        rows, _ = compare(manifest, digests, state.get("files", {}))
        return rows, False, "PyPI did not serve every file within the timeout"
    rows, ok = compare(manifest, digests, state["files"])
    return rows, ok, "" if ok else "PyPI digests do not match the build"


def main(argv=None, **kwargs):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True, help="JSON from upload")
    parser.add_argument("--digests", required=True, help="JSON from build")
    parser.add_argument("--packages", required=True, help="JSON list")
    parser.add_argument("--version", required=True)
    args = parser.parse_args(argv)
    manifest = json.loads(args.manifest)
    rows, ok, message = run_check(
        manifest, json.loads(args.digests), json.loads(args.packages),
        args.version, **kwargs,
    )
    table = render(rows, args.version)
    print(table)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as f:
            f.write(table)
    if not ok:
        print(f"::error::{message}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
