#!/usr/bin/env python3
"""Build a minimal Chrome Web Store ZIP and matching unpacked runtime."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED

ROOT = Path(__file__).resolve().parents[1]
BASE = [
    'manifest.json', 'background.js', 'providers.js', 'shared.js', 'content.js',
    'content.css', 'player-metadata.js', 'popup.html', 'popup.js', 'privacy.html',
    'THIRD_PARTY_NOTICES.md',
    'vendor/yaml.min.js', 'vendor/yaml.LICENSE.txt',
    'vendor/braccato.min.js', 'vendor/braccato.LICENSE.txt',
    'vendor/parsers.min.js', 'vendor/parsers.LICENSE.txt',
]

def build(output):
    manifest = json.loads((ROOT / 'manifest.json').read_text())
    assert manifest['manifest_version'] == 3
    assert 0 < len(manifest['description']) <= 132
    assert manifest['permissions'] == ['storage']
    assert '<all_urls>' not in manifest['host_permissions']
    files = set(BASE)
    files.update(manifest['icons'].values())
    files.update(manifest['action']['default_icon'].values())
    references = {manifest['background']['service_worker'], manifest['action']['default_popup']}
    for script in manifest['content_scripts']:
        references.update(script.get('js', []))
        references.update(script.get('css', []))
    for call in re.findall(r'importScripts\s*\((.*?)\)', (ROOT / 'background.js').read_text(), re.S):
        references.update(re.findall(r'["\']([^"\']+)["\']', call))
    assert references <= files, f'Missing runtime files: {references - files}'
    for name in files:
        path = ROOT / name
        assert path.is_file() and path.resolve().is_relative_to(ROOT)
    output = output.resolve()
    assert output != ROOT and (ROOT not in output.parents or output.is_relative_to(ROOT / 'dist')), 'Use dist or an external output folder'
    output.mkdir(parents=True, exist_ok=True)
    unpacked = output / 'unpacked'
    # This tool owns only this subdirectory and the generated versioned ZIP.
    if unpacked.exists():
        shutil.rmtree(unpacked)
    unpacked.mkdir()
    version = manifest['version']
    archive_path = output / f'animated-lyrics-{version}-chrome-web-store.zip'
    ordered = ['manifest.json'] + sorted(files - {'manifest.json'})
    with ZipFile(archive_path, 'w', ZIP_DEFLATED, compresslevel=9) as archive:
        for name in ordered:
            data = (ROOT / name).read_bytes()
            target = unpacked / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            info = ZipInfo(name, (2026, 1, 1, 0, 0, 0))
            info.compress_type = ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, data)
    with ZipFile(archive_path) as archive:
        assert archive.testzip() is None
        assert archive.namelist()[0] == 'manifest.json'
        assert set(archive.namelist()) == files
    result = {
        'version': version, 'zip': archive_path.name,
        'bytes': archive_path.stat().st_size,
        'sha256': hashlib.sha256(archive_path.read_bytes()).hexdigest(),
        'manifestAtRoot': True, 'files': ordered,
    }
    (output / 'package-report.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({k:v for k,v in result.items() if k != 'files'}, indent=2))

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT / 'dist' / 'release')
    build(parser.parse_args().output)
