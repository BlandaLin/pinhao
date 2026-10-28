"""Apply PinHao's small MIT-source patch to WolfTL v0.6.2 and optionally build it."""
import argparse
import hashlib
from pathlib import Path
import subprocess


def replace(text, before, after, count=1):
    if text.count(before) != count:
        raise ValueError('Expected the exact, unmodified WolfTL v0.6.2 source')
    return text.replace(before, after)


def patch(source):
    root = source / 'WolfTL' / 'WolfRPG'
    changes = {}
    for name in ('CommonEvents.hpp', 'Database.hpp', 'WolfDataBase.hpp'):
        path = root / name
        text = path.read_text(encoding='utf-8-sig')
        changes[path] = replace(text, 'std::ofstream out(outputFilePath);',
                                'std::ofstream out(outputFilePath);\n\t\tout.exceptions(std::ios::failbit | std::ios::badbit);')
    path = root / 'FileAccess.hpp'
    text = path.read_text(encoding='utf-8-sig')
    for operation, pointer in (('ReadBytes', 'void*'), ('WriteBytes', 'const void*')):
        old = ('\tvoid ' + operation + '(' + pointer + ' pBuffer, const std::size_t& size)\n'
               '\t{\n\t\t' + operation + '(pBuffer, static_cast<uint32_t>(size));\n\t}\n\n'
               '\tvoid ' + operation + '(' + pointer + ' pBuffer, const uint32_t& size)')
        new = '\tvoid ' + operation + '(' + pointer + ' pBuffer, const std::size_t& size)'
        text = replace(text, old, new)
    start = text.index('\tvoid ReadBytes(void* pBuffer, const std::size_t& size)')
    end = text.index('\ttemplate<typename T>', start)
    block = text[start:end]
    block = replace(block, 'm_offset + size > m_size', 'size > m_size - m_offset')
    block = replace(block, 'm_offset += size;', 'm_offset += static_cast<uint32_t>(size);')
    text = text[:start] + block + text[end:]
    text = replace(text, 'std::ofstream file(filePath, std::ios::out | std::ios::binary);',
                   'std::ofstream file(filePath, std::ios::out | std::ios::binary);\n\t\tfile.exceptions(std::ios::failbit | std::ios::badbit);', count=2)
    changes[path] = text
    path = root / 'WolfRPGUtils.hpp'
    text = path.read_text(encoding='utf-8-sig')
    marker = 'path = std::regex_replace(path, std::wregex(L"['
    changes[path] = replace(text, marker, marker + r'\n\r')
    for path, text in changes.items():
        path.write_text(text, encoding='utf-8', newline='\n')


def build(source, compiler, output):
    if output.exists():
        raise ValueError('Choose a new codec executable output')
    output.parent.mkdir(parents=True, exist_ok=True)
    obj = output.with_suffix('.lz4.o')
    gcc = compiler.with_name('gcc.exe')
    prefix_maps = []
    for directory, target in ((source.resolve(), '/pinhao/source'),
                              (compiler.resolve().parent.parent, '/pinhao/toolchain')):
        prefixes = {str(directory), directory.as_posix()}
        prefixes.update(prefix[0].lower() + prefix[1:] for prefix in tuple(prefixes))
        prefix_maps.extend('-ffile-prefix-map=' + prefix + '=' + target
                           for prefix in sorted(prefixes))
    subprocess.run([str(gcc), '-O2', *prefix_maps, '-c', str(source / 'WolfTL/3rdParty/lz4/lz4.c'), '-o', str(obj)], check=True)
    command = [str(compiler), '-std=c++20', '-O2', '-static', '-static-libgcc', '-static-libstdc++',
               *prefix_maps,
               '-DUNICODE', '-D_UNICODE', '-DNOMINMAX', '-I' + str(source / 'WolfTL/3rdParty'),
               '-I' + str(source / 'WolfTL'), str(source / 'WolfTL/WolfTL.cpp'), str(obj),
               '-lshell32', '-o', str(output)]
    subprocess.run(command, check=True)
    obj.unlink()
    print('Built SHA256: ' + hashlib.sha256(output.read_bytes()).hexdigest())


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--compiler', type=Path)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    patch(args.source.resolve())
    if args.compiler:
        if not args.output:
            parser.error('--output is required when compiling')
        build(args.source.resolve(), args.compiler.resolve(), args.output.resolve())
