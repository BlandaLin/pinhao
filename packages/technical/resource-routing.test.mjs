import test from 'node:test';
import assert from 'node:assert/strict';
import { RESOURCE_ROUTES, resourceRoute, isTextSearchResource, isSourceContextResource, isDisplaySampleResource, resourceRouteSummary } from './resource-routing.mjs';

test('one routing policy covers native carriers and readable sources across all engine families', () => {
  const cases = [
    ['MV', 'data/Map001.json', 'text', true], ['MZ', 'js/plugins/Dialogue.js', 'script', true],
    ['XP', 'Data/Scripts.rxdata', 'container', false], ['VX', 'Game.rgss2a', 'container', false],
    ['VX Ace', 'Data/Map001.rvdata2', 'container', false], ['2000', 'RPG_RT.ldb', 'container', false],
    ['2003', 'Map0001.lmu', 'container', false], ['WOLF', 'Data.wolf', 'container', false],
    ['KAG', 'scenario/main.ks', 'script', true], ['Tyrano', 'data/scenario/main.ks', 'script', true],
    ['RenPy', 'game/script.rpyc', 'container', false], ['PGMM', 'data/project.json', 'text', true],
    ['SGB', 'map.sgr', 'container', false], ['Bakin', 'map.rbr', 'container', false],
    ['Godot', 'game.pck', 'container', false], ['Unity', 'Game_Data/resources.assets', 'container', false],
  ];
  for (const [engine, file, route, searchable] of cases) {
    assert.equal(resourceRoute(file), route, `${engine}: ${file}`);
    assert.equal(isTextSearchResource(file), searchable, `${engine}: ${file}`);
  }
});

test('ambiguous suffixes are not binary verdicts and compiled scripts do not hide readable siblings', () => {
  for (const file of ['story.dat', 'dialogue.bin', 'strings.db', 'extensionless']) {
    assert.equal(resourceRoute(file), 'unknown');
    assert.equal(isTextSearchResource(file), true);
  }
  for (const file of ['font.fnt', 'screen.svg', 'prefab.asset']) assert.equal(isTextSearchResource(file), true);
  for (const [source, compiled] of [['menu.gd', 'menu.gdc'], ['story.rpy', 'story.rpyc']]) {
    assert.equal(resourceRoute(source), 'script');
    assert.equal(resourceRoute(compiled), 'container');
    assert.equal(isTextSearchResource(compiled), false);
  }
  assert.equal(resourceRoute('C:\\Game\\SCRIPTS\\MENU.GD'), 'script');
  for (const file of ['title.png', 'audio.ogg_', 'video.webm', 'font.ttf', 'Assembly-CSharp.dll']) assert.equal(isTextSearchResource(file), false);
});

test('route counts do not depend on coverage status or hide mixed container contents', () => {
  const resources = [{ file: 'story.json', kind: 'technical-metadata' }, { file: 'pack.pck', kind: 'display-text-candidate' },
    { file: 'title.png', kind: 'extracted' }, { path: 'new-format.custom', kind: 'unclassified' }];
  const counts = resourceRouteSummary(resources);
  assert.deepEqual(Object.keys(counts), RESOURCE_ROUTES);
  assert.equal(counts.text, 1); assert.equal(counts.container, 1); assert.equal(counts.image, 1); assert.equal(counts.unknown, 1);
  assert.equal(Object.values(counts).reduce((sum, count) => sum + count, 0), resources.length);
});

test('compiled consumer context is independent of raw text-search routing', () => {
  for (const file of ['Assembly-CSharp.dll', 'menu.gdc', 'story.rpyc']) {
    assert.equal(isTextSearchResource(file), false);
    assert.equal(isSourceContextResource(file), true);
  }
  for (const file of ['font.png', 'sound.ogg']) assert.equal(isSourceContextResource(file), false);
});

test('readability is not a generic display-review admission rule', () => {
  for (const file of ['bootstrap.py', 'battle.cs', 'credits.html', 'widget.mjs']) {
    assert.equal(isTextSearchResource(file), true);
    assert.equal(isSourceContextResource(file), true);
    assert.equal(isDisplaySampleResource(file), false);
  }
  for (const file of ['scenario.ks', 'story.rpy', 'Vocab.rb', 'dialogue.dat']) assert.equal(isDisplaySampleResource(file), true);
});
