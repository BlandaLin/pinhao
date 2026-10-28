# PGMM Resource Codec

Pixel Game Maker MV encrypted resources use an `enc` header and Twofish CBC.
The project resource key is recovered from its original `info.json` key field.
The adapter stages plaintext resources for the workbench, then encrypts the
originally encrypted files again after text, font and image changes.

## Dependency

- Repository: https://github.com/wqhanginge/PGMMV_Decrypter
- Release: `v0.6.0`
- Commit: `dd3a35176789dc39667159c6efaf1054cdde9051`
- Wheel: `pgmdec-0.6.0-cp312-cp312-win_amd64.whl`
- SHA-256: `6f7826cefa88f1e0060fa5104d644750dfb87a7a12816f64f6d56f77aef90958`
- License: MIT, with the accompanying Twofish implementation notice.

Run `node scripts/prepare-pgmm-tools.mjs` to install the fixed component for
the bundled Python 3.12 Windows x64 runtime. The `PINHAO_PGMM_CODEC` variable
selects the directory containing its `pgmdec` package during development.
The game output uses the original game's resource loader; the codec remains
a workbench dependency.

## Engine References

Layout and font field behavior follow the public engine implementation:

- https://github.com/GGGweb-adm/PGMMV/blob/5384a4fd2beac585e5ab049f52189518378719ee/Player/Classes/AppDelegate.cpp
- https://github.com/GGGweb-adm/PGMMV/blob/5384a4fd2beac585e5ab049f52189518378719ee/Player/Classes/Manager/FontManager.cpp
- https://github.com/GGGweb-adm/PGMMV/blob/5384a4fd2beac585e5ab049f52189518378719ee/Player/Classes/Data/AssetData.cpp
