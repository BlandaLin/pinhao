# Unity Native Asset Codec

The Unity adapter uses **UnityPy 1.23.0**, an MIT-licensed native serialized asset
reader/writer. It is a separate dependency, not copied into the product source.

- Source: https://github.com/K0lb3/UnityPy/tree/v1.23.0
- Package: https://pypi.org/project/UnityPy/1.23.0/
- Preparation: `node scripts/prepare-unity-tools.mjs`
- Runtime search: `PINHAO_UNITYPY`, then `local/dependencies/unitypy`.

The preparation script pins Windows CPython 3.12 wheels by version, filename and
SHA-256. It extracts all upstream license and metadata files beside the runtime
modules. UnityPy is MIT; its dependency set contains MIT, BSD, Apache-2.0 and
Pillow/HPND-family licenses. Preserve every included `.dist-info` license when
redistributing the prepared dependency directory. UnityPy's upstream wheel also
includes two proprietary FMOD DLLs. The preparation script removes those exact
audio-only files and records the exclusions in its provenance manifest. It keeps
the MIT pyfmodex Python wrapper; the text adapter uses no audio conversion.

UnityPy 1.23.0's `parse_as_dict` and `save_typetree` APIs are used directly. All
edited carriers are reloaded and checked by object identity, full edited trees,
unchanged object bytes, opaque bundle members and external references. Tests
construct neutral serialized assets and UnityFS bundles from scratch; no game
assets or vendor research code are distributed with these tests.
