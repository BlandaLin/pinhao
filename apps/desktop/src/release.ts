import { uiLanguage } from "../shared/ui-language.js";

export function releaseArchivePath(name: string, buildPath: string): string {
  return archivePath(name, buildPath, uiLanguage === "en" ? "-localized.zip" : "-内嵌汉化版.zip");
}

export function joiplayArchivePath(name: string, buildPath: string): string {
  return archivePath(name, buildPath, "-JoiPlay.rga");
}

function archivePath(name: string, buildPath: string, suffix: string): string {
  const filename =
    name
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
      .replace(/[. ]+$/g, "")
      .trim() || (uiLanguage === "en" ? "game" : "游戏");
  const parent = buildPath.replace(/[\\/]+$/g, "").replace(/[^\\/]+$/g, "");
  return `${parent}${filename}${suffix}`;
}
