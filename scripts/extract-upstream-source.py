"""Retain pinned upstream preferred sources without website/demo distributions.

Author: ahui. SPDX-License-Identifier: GPL-3.0-only.
Selection is explicit in sources.json; original file bytes and copyright stay intact.
Archives are verified before extraction and paths cannot escape the staging folder.
"""
import hashlib
import json
from pathlib import Path, PurePosixPath
import sys
import shutil
import zipfile

root = Path(__file__).resolve().parent.parent
target = Path(sys.argv[1]).resolve()
assert target.is_relative_to(root / 'node_modules/.cache/ecg-source')
# This generated staging tree is disposable; stale files must not survive a
# narrower reviewed source selection. The checked absolute boundary precedes deletion.
if target.exists():
    shutil.rmtree(target)
source = root / 'resources/source-upstream'
for item in json.loads((source / 'sources.json').read_text(encoding='utf-8')):
    archive = source / item['name']
    assert hashlib.sha256(archive.read_bytes()).hexdigest() == item['sha256'], item['name']
    with zipfile.ZipFile(archive) as files:
        for entry in files.infolist():
            if entry.is_dir():
                continue
            relative = PurePosixPath(entry.filename)
            assert not relative.is_absolute() and '..' not in relative.parts
            parts = relative.parts[1:]
            if not parts:
                continue
            name = '/'.join(parts)
            # Upstream test snapshots/demos are not needed to modify or compile
            # the linked library. Preserve actual source/build files and licenses.
            if any(part in ('__tests__', 'tests', 'test', '__snapshots__', 'screenshots') for part in parts):
                continue
            # Root metadata/licenses and all explicitly selected source/build trees.
            include = item.get('include')
            if include and len(parts) > 1 and not any(name.startswith(p) for p in include):
                continue
            destination = target / item['name'].removesuffix('.zip') / name
            assert destination.resolve().is_relative_to(target)
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(files.read(entry))
