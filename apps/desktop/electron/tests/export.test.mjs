import test from "node:test";
import assert from "node:assert/strict";
import { joiplayArchivePath, releaseArchivePath } from "../../src/release.ts";

test("share ZIP defaults to the game name rather than the build ID", () => {
  assert.equal(
    releaseArchivePath("からから唐揚げ", "C:\\projects\\outputs\\build-uuid"),
    "C:\\projects\\outputs\\からから唐揚げ-内嵌汉化版.zip",
  );
  assert.equal(
    releaseArchivePath("Game name", "/projects/outputs/build-uuid/"),
    "/projects/outputs/Game name-内嵌汉化版.zip",
  );
});

test("share ZIP keeps Unicode game names and normalizes Windows filename characters", () => {
  assert.equal(
    releaseArchivePath("英雄:序章 / Chapter? . ", "D:\\games\\build-uuid"),
    "D:\\games\\英雄_序章 _ Chapter_-内嵌汉化版.zip",
  );
  assert.equal(
    releaseArchivePath("   ", "C:\\games\\build-uuid\\"),
    "C:\\games\\游戏-内嵌汉化版.zip",
  );
});

test("JoiPlay packages use the game name and the standard RGA extension", () => {
  assert.equal(
    joiplayArchivePath("からから唐揚げ", "C:\\projects\\outputs\\build-uuid"),
    "C:\\projects\\outputs\\からから唐揚げ-JoiPlay.rga",
  );
  assert.equal(
    joiplayArchivePath("英雄:序章? . ", "/projects/outputs/build-uuid/"),
    "/projects/outputs/英雄_序章_-JoiPlay.rga",
  );
  assert.equal(
    joiplayArchivePath("   ", "D:\\games\\build-uuid"),
    "D:\\games\\游戏-JoiPlay.rga",
  );
});
