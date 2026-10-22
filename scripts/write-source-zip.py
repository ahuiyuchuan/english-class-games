"""Write a deterministic source ZIP and reject edits after its inventory was taken.

Author: ahui. SPDX-License-Identifier: GPL-3.0-only.
Files are streamed one at a time; large native source trees do not share one buffer.
"""
import hashlib
import json
from pathlib import Path
import sys
import zipfile

entries = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
# Duplicate manifests are ambiguous to ZIP readers and would invalidate source
# receipts after rebuilding an extracted source distribution. Reject before writing.
if len({entry[1] for entry in entries}) != len(entries):
    raise RuntimeError('Duplicate source archive path; preserve inputs and rebuild')
with zipfile.ZipFile(sys.argv[2], 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
    for filename, name, expected in entries:
        data = Path(filename).read_bytes()
        if hashlib.sha256(data).hexdigest() != expected:
            raise RuntimeError('Source changed during packaging; rebuild: ' + name)
        archive.writestr(zipfile.ZipInfo(name, (2026, 10, 23, 0, 0, 0)), data,
                         compress_type=zipfile.ZIP_DEFLATED, compresslevel=6)
