"""Measure existing release files/ZIP metadata without making another release."""

import argparse
from collections import defaultdict
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
from zipfile import ZipFile


APP = "resources/app/"
DSH = APP + "resources/dsh/"


def filesystem_path(path):
    text = str(path)
    if os.name == "nt" and not text.startswith("\\\\?\\"):
        return Path("\\\\?\\UNC\\" + text[2:] if text.startswith("\\\\") else "\\\\?\\" + text)
    return path


def relative_file(value):
    path = PurePosixPath(value)
    if not value or "\\" in value or path.is_absolute() or ":" in value or ".." in path.parts or path.as_posix() != value:
        raise ValueError("Invalid release-relative file path")
    return value


def component(file, packages):
    if file == "SOURCE-CODE.zip":
        return "source"
    if "/" not in file and file.endswith(".txt"):
        return "delivery-notes"
    if file.startswith(DSH + "node/"):
        return "dsh-node"
    if file.startswith(DSH + "node_modules/"):
        owner = next((p for p in packages if file.startswith(DSH + p["path"] + "/")), None)
        return "dsh-workspace" if owner and owner.get("workspace") else "dsh-third-party"
    if file.startswith(DSH):
        return "dsh-metadata"
    for prefix, name in [("python/", "python"), ("dependencies/", "engine-tools"), ("fonts/", "fonts"),
                         ("adapters/", "adapters-toolkit"), ("toolkit/", "adapters-toolkit")]:
        if file.startswith(APP + "resources/" + prefix):
            return name
    if file == APP + "resources/tool-versions.json":
        return "tool-metadata"
    if file.startswith(APP + "node_modules/"):
        return "host-native-dependencies"
    if file.startswith(APP + "THIRD_PARTY_LICENSES/") or file in [APP + "LICENSE", APP + "COPYING"]:
        return "app-licenses"
    return "pinhao-js-ui" if file.startswith(APP) else "electron"


def file_paths(directory):
    for parent, directories, files in os.walk(directory):
        for name in directories + files:
            entry = Path(parent) / name
            if entry.is_symlink() or (hasattr(entry, "is_junction") and entry.is_junction()):
                raise ValueError("Release measurement refuses links")
        for name in files:
            yield Path(parent) / name


def collect_files(directory):
    records = []
    for entry in file_paths(directory):
        digest = hashlib.sha256()
        with entry.open("rb") as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(block)
        records.append({"path": entry.relative_to(directory).as_posix(), "bytes": entry.stat().st_size, "sha256": digest.hexdigest()})
    return records


def measure_release(directory, manifest=None, archive=None, build_options=None):
    directory = filesystem_path(Path(directory).resolve(strict=True))
    if manifest:
        manifest_bytes = Path(manifest).read_bytes()
        identity = json.loads(manifest_bytes)
        records = identity["manifest"]
        origin = {"kind": "existing-manifest", "sha256": hashlib.sha256(manifest_bytes).hexdigest(),
                  "payloadHashesRecomputed": False, "version": identity.get("version")}
    else:
        records = collect_files(directory)
        origin = {"kind": "directory-scan", "payloadHashesRecomputed": True}
    dependency_file = directory / (DSH + "runtime-dependencies.json")
    packages = json.loads(dependency_file.read_text(encoding="utf-8"))["packages"] if dependency_file.is_file() else []
    packages = sorted(packages, key=lambda p: len(p["path"]), reverse=True)
    files, seen = [], set()
    for record in records:
        file = relative_file(record["path"])
        if file in seen or not isinstance(record["bytes"], int) or record["bytes"] < 0:
            raise ValueError("Duplicate path or invalid byte count in release manifest")
        seen.add(file)
        entry = directory / file
        if not entry.is_file() or entry.stat().st_size != record["bytes"]:
            raise ValueError("Release length differs from its manifest: " + file)
        owner = next((p for p in packages if file.startswith(DSH + p["path"] + "/")), None)
        files.append({"relativePath": file, "component": component(file, packages), "logicalBytes": record["bytes"],
                      "sha256": record.get("sha256"), "package": owner["name"] if owner else None,
                      "packageVersion": owner["version"] if owner else None})
    if manifest and {p.relative_to(directory).as_posix() for p in file_paths(directory)} != seen:
        raise ValueError("Directory and manifest file sets differ")
    zip_metadata = None
    if archive:
        compressed, zip_seen = {}, set()
        with ZipFile(filesystem_path(Path(archive).resolve(strict=True))) as zipped:
            for entry in zipped.infolist():
                if entry.is_dir():
                    continue
                parts = entry.filename.split("/", 1)
                if len(parts) != 2 or parts[0] != directory.name:
                    raise ValueError("ZIP root differs from the release directory")
                file = relative_file(parts[1])
                if file in zip_seen:
                    raise ValueError("Duplicate file in ZIP")
                zip_seen.add(file)
                compressed[file] = (entry.file_size, entry.compress_size)
        if zip_seen != seen:
            raise ValueError("ZIP and release file sets differ")
        for entry in files:
            length, size = compressed[entry["relativePath"]]
            if length != entry["logicalBytes"]:
                raise ValueError("ZIP and release logical lengths differ")
            entry["compressedBytes"] = size
        payload = sum(p[1] for p in compressed.values())
        size = Path(archive).stat().st_size
        zip_metadata = {"bytes": size, "compressedPayloadBytes": payload, "structureBytes": size - payload,
                        "method": "central-directory-only; no extraction or CRC/payload revalidation"}
    groups, duplicates = defaultdict(list), defaultdict(list)
    for entry in files:
        groups[entry["component"]].append(entry)
        if entry["sha256"] and entry["logicalBytes"]:
            duplicates[(entry["sha256"], entry["logicalBytes"])].append(entry["relativePath"])
    components = []
    for name, entries in sorted(groups.items()):
        row = {"component": name, "files": len(entries), "logicalBytes": sum(p["logicalBytes"] for p in entries),
               "largestFiles": [{"relativePath": p["relativePath"], "logicalBytes": p["logicalBytes"]}
                                for p in sorted(entries, key=lambda p: (-p["logicalBytes"], p["relativePath"]))[:3]]}
        if archive:
            row["compressedBytes"] = sum(p["compressedBytes"] for p in entries)
        components.append(row)
    duplicate_groups = [{"sha256": sha, "logicalBytes": size, "paths": paths, "redundantLogicalBytes": size * (len(paths) - 1)}
                        for (sha, size), paths in duplicates.items() if len(paths) > 1]
    lock = Path(__file__).resolve().parents[1] / "package-lock.json"
    return {"schema": "pinhao-release-size-1", "target": "win32-x64", "buildOptions": build_options or {},
            "origin": origin, "measurementToolLockfileSha256": hashlib.sha256(lock.read_bytes()).hexdigest() if lock.is_file() else None,
            "files": len(files), "logicalBytes": sum(p["logicalBytes"] for p in files), "archive": zip_metadata,
            "firstLaunchAddedBytes": None, "allocatedDiskBytes": None, "runtimeMemoryBytes": None,
            "components": components, "duplicateCandidates": sorted(duplicate_groups, key=lambda p: (-p["redundantLogicalBytes"], p["sha256"])),
            "duplicateCandidatesAreNotDeletionApproval": True, "manifest": sorted(files, key=lambda p: p["relativePath"])}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", required=True)
    parser.add_argument("--manifest")
    parser.add_argument("--archive")
    parser.add_argument("--output", required=True)
    parser.add_argument("--acceptance-bundle", action="store_true")
    args = parser.parse_args()
    report = measure_release(args.directory, args.manifest, args.archive, {"acceptanceBundle": args.acceptance_bundle})
    target = Path(args.output).resolve()
    if target.is_relative_to(Path(args.directory).resolve()):
        raise ValueError("The size report belongs outside the measured program directory")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"files": report["files"], "logicalBytes": report["logicalBytes"], "archive": report["archive"]}))


if __name__ == "__main__":
    main()
