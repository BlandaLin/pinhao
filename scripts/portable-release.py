"""Create the portable archive from a freshly packaged Electron directory."""

import json
import sys
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

ROOT_FILES = (
    "PinhaoWorkbench.exe", "chrome_100_percent.pak", "chrome_200_percent.pak",
    "d3dcompiler_47.dll", "dxcompiler.dll", "dxil.dll", "ffmpeg.dll", "icudtl.dat",
    "libEGL.dll", "libGLESv2.dll", "resources.pak", "snapshot_blob.bin",
    "v8_context_snapshot.bin", "vk_swiftshader_icd.json", "vk_swiftshader.dll",
    "vulkan-1.dll", "version", "LICENSE", "LICENSES.chromium.html",
    "SOURCE-CODE.zip", "拼好汉化-LICENSE.txt", "使用说明.txt", "测试说明.txt",
)
ROOT_DIRECTORIES = ("locales", "resources")
OPTIONAL_FILES = {"libEGL.dll", "libGLESv2.dll"}


def filesystem_path(value):
    if sys.platform != "win32":
        return value
    text = str(value)
    if text.startswith("\\\\?\\"):
        return value
    if text.startswith("\\\\"):
        return Path("\\\\?\\UNC\\" + text[2:])
    return Path("\\\\?\\" + text)


def archive_release(directory, target):
    # Embedded Python may silently classify long Windows paths as non-files.
    root = filesystem_path(Path(directory).resolve(strict=True))
    display_archive = Path(target).resolve()
    archive = filesystem_path(display_archive)
    if not root.is_dir() or archive.is_relative_to(root):
        raise ValueError("发行目录与压缩包路径需要分开")
    files = []
    for name in ROOT_FILES:
        entry = root / name
        if name in OPTIONAL_FILES and not entry.exists():
            continue
        if not entry.is_file():
            raise ValueError(f"发行文件缺失：{name}")
        files.append(entry)
    for name in ROOT_DIRECTORIES:
        entry = root / name
        if not entry.is_dir():
            raise ValueError(f"发行资源目录缺失：{name}")
        files.extend(item for item in entry.rglob("*") if item.is_file())
    for entry in files + [root / name for name in ROOT_DIRECTORIES]:
        if entry.is_symlink() or any(part.is_symlink() or (hasattr(part, "is_junction") and part.is_junction()) for part in [entry, *entry.parents] if part.is_relative_to(root)):
            raise ValueError("发行内容需要普通文件和目录")
        if not entry.resolve(strict=True).is_relative_to(root):
            raise ValueError("发行文件位于目录边界之外")
    with ZipFile(archive, "x", ZIP_DEFLATED, compresslevel=6) as output:
        for entry in sorted(files):
            output.write(entry, (Path(root.name) / entry.relative_to(root)).as_posix())
    with ZipFile(archive) as output:
        if output.testzip() is not None:
            raise ValueError("发行压缩包校验失败")
    return {"path": str(display_archive), "files": len(files), "bytes": archive.stat().st_size}


if __name__ == "__main__":
    print(json.dumps(archive_release(*sys.argv[1:]), ensure_ascii=False))
