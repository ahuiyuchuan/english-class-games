"""Retain ONNX Runtime CPU build sources, excluding optional bindings/test datasets.

Author: ahui. SPDX-License-Identifier: GPL-3.0-only.
Input is the pinned upstream archive, output preserves every selected file byte.
The original archive digest and explicit selection remain in source-lock.json.
"""
import hashlib
import json
from pathlib import Path
import sys
import zipfile

original, output = map(Path, sys.argv[1:3])
assert original.resolve() != output.resolve()
roots = ('onnxruntime/', 'include/', 'cmake/', 'tools/')
with zipfile.ZipFile(original) as source, zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as target:
    for entry in source.infolist():
        if entry.is_dir():
            continue
        relative = '/'.join(entry.filename.split('/')[1:])
        if not relative or relative.startswith('onnxruntime/test/'):
            continue
        if '/' in relative and not relative.startswith(roots):
            continue
        target.writestr(zipfile.ZipInfo(entry.filename, (2026, 10, 23, 0, 0, 0)), source.read(entry),
                        compress_type=zipfile.ZIP_DEFLATED, compresslevel=6)
lockfile = output.parent / 'source-lock.json'
lock = json.loads(lockfile.read_text(encoding='utf-8'))
item = next(item for item in lock if item['name'] == output.name)
item['originalArchiveSha256'] = hashlib.sha256(original.read_bytes()).hexdigest()
item['retainedSourceSelection'] = 'Root metadata/licenses; onnxruntime (except test datasets), include, cmake, tools. No source file is edited. CPU inference build; optional training and other language bindings omitted.'
item['sha256'] = hashlib.sha256(output.read_bytes()).hexdigest()
item['bytes'] = output.stat().st_size
lockfile.write_text(json.dumps(lock, indent=2) + '\n', encoding='utf-8')
print(json.dumps(item))
