"""Read-only-source native verification. Reports counts and hashes, never story text."""
import argparse
import json
from pathlib import Path
import tempfile

import worker


def verify(game, report_path, assemble=False, font=None):
    parent = worker.ROOT / 'local' / 'native-tests'
    parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='real-native-', dir=parent) as temp:
        root = Path(temp)
        work = root / 'work'
        extracted = worker.extract({'gameDir': str(game), 'workspaceDir': str(work)})
        print(json.dumps({'stage': 'extracted', 'engine': extracted['engine'], 'units': len(extracted['units'])}), flush=True)
        roundtrip = worker.roundtrip({'workspaceDir': str(work)})
        print(json.dumps({'stage': 'roundtrip', **roundtrip}), flush=True)
        target = next(row for row in extracted['units'] if row['kind'] == 'system_text')
        built = worker.build({'workspaceDir': str(work), 'outputDir': str(root / 'built'),
                              'translations': [{'legacyId': target['id'], 'translation': 'PHH Native Check ' + target['translation']}]})
        assembly = None
        if assemble:
            args = {'gameDir': str(game), 'workspaceDir': str(work), 'buildDir': str(root / 'built'),
                    'outputDir': str(root / 'assembled')}
            if font:
                args['fontPath'] = str(font)
            result = worker.assemble(args)
            assembly = {key: result[key] for key in ('copied', 'excluded', 'warnings', 'engine', 'nativeFiles', 'launchers')}
            if font:
                assembly['font'] = result.get('font')
        metadata = worker.native.read(work / 'technical' / 'product-source.json')
        worker.source_unchanged(game, metadata)
        report = {'engine': extracted['engine'], 'units': len(extracted['units']),
                  'sourceFingerprint': extracted['sourceFingerprint'], 'roundtrip': roundtrip,
                  'changedBuild': {'changed': built['changed'], 'files': built['files'], 'status': built['status']},
                  'sourceUnchanged': True, 'runtimeVerified': False}
        if assembly:
            report['assembly'] = assembly
        worker.json_write(report_path, report)
        print(json.dumps(report, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--game', type=Path, required=True)
    parser.add_argument('--report', type=Path, required=True)
    parser.add_argument('--assemble', action='store_true')
    parser.add_argument('--font', type=Path)
    args = parser.parse_args()
    verify(args.game, args.report, args.assemble, args.font)
