"""Fixed neutral fixtures; time complete native build with inline translations."""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
import os
from pathlib import Path
import statistics
import sys
import tempfile
import time
from unittest import mock


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--sizes', default='10000,30000')
    parser.add_argument('--iterations', type=int, default=5)
    parser.add_argument('--command', choices=('build', 'roundtrip'), default='build')
    args = parser.parse_args()
    source = args.source.resolve()
    toolkit = source / 'kits' / 'workbench-tutorial' / 'toolkit'
    os.environ['PINHAO_TOOLKIT'] = str(toolkit)
    sys.path[:0] = [str(source / 'adapters' / 'python'), str(toolkit)]
    import worker
    from test_rpgmaker import json_game

    results = {'schema': 'pinhao-native-build-benchmark-v1', 'python': sys.version, 'command': args.command,
               'iterations': args.iterations, 'warmups': 1, 'apiRequests': 0,
               'readMetric': 'Path.read_bytes calls and returned bytes; excludes small checksum read_text and OS cache effects',
               'scenarios': []}
    parent = args.out.resolve().parent
    parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='native-build-bench-', dir=parent) as folder:
        root = Path(folder)
        for size in [int(value) for value in args.sizes.split(',')]:
            game, work = root / f'game-{size}', root / f'work-{size}'
            json_game(game)
            actors = [None] + [{'id': index + 1, 'name': f'Neutral actor {index:06}',
                               'nickname': '', 'profile': '', 'note': '', 'level': 3}
                              for index in range(size)]
            worker.json_write(game / 'data' / 'Actors.json', actors)
            extracted = worker.extract({'gameDir': str(game), 'workspaceDir': str(work), 'batchSize': 120})
            changes = [{'id': row['id'], 'translation': f'Adjusted actor {index:06}'}
                       for index, row in enumerate(extracted['units'])
                       if row['kind'] == 'database_name' and index % 17 == 0]
            if args.command == 'roundtrip':
                changes = []
            source_digest = hashlib.sha256((game / 'data' / 'Actors.json').read_bytes()).hexdigest()
            input_digest = hashlib.sha256(worker.native.serialized(changes)).hexdigest()
            times, operations, hashes = [], [], []
            for iteration in range(args.iterations + 1):
                output = root / f'build-{size}-{iteration}'
                counts = Counter()
                original_read = Path.read_bytes

                def counted_read(path):
                    value = original_read(path)
                    category = ('baseline' if path.is_relative_to(work / 'baseline') else
                                'rowBaseline' if path.is_relative_to(work / 'technical' / 'row-baseline') else
                                'editable' if path.is_relative_to(work / 'editable') else
                                'manifest' if path == work / 'manifest.json' else
                                'output' if path.is_relative_to(output) else 'temporary')
                    counts[category + 'Reads'] += 1
                    counts[category + 'Bytes'] += len(value)
                    counts['totalReads'] += 1
                    counts['totalBytes'] += len(value)
                    return value

                with mock.patch.object(Path, 'read_bytes', counted_read):
                    started = time.perf_counter()
                    inputs = {'workspaceDir': str(work), 'outputDir': str(output), 'translations': changes}
                    report = worker.build(inputs) if args.command == 'build' else worker.roundtrip(inputs)
                    elapsed = (time.perf_counter() - started) * 1000
                assert report.get('changed', 0) == len(changes)
                if args.command == 'roundtrip':
                    assert report['byteIdentical']
                digest = hashlib.sha256()
                for path in sorted(output.rglob('*')):
                    if path.is_file():
                        digest.update(path.relative_to(output).as_posix().encode())
                        digest.update(path.read_bytes())
                if iteration:
                    times.append(elapsed)
                    operations.append(dict(counts))
                    hashes.append(digest.hexdigest())
                assert hashlib.sha256((game / 'data' / 'Actors.json').read_bytes()).hexdigest() == source_digest
            assert len(set(hashes)) == 1
            assert all(counts == operations[0] for counts in operations)
            results['scenarios'].append({
                'actors': size, 'units': len(extracted['units']), 'changed': len(changes),
                'inputSha256': input_digest, 'sourceSha256': source_digest, 'outputSha256': hashes[0],
                'milliseconds': {'median': statistics.median(times), 'min': min(times), 'max': max(times),
                                 'samples': times},
                'reads': operations[0]})
            print(json.dumps(results['scenarios'][-1]), flush=True)
    args.out.write_text(json.dumps(results, indent=2) + '\n', encoding='utf-8')


if __name__ == '__main__':
    main()
