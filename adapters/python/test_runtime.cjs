/* Synthetic engine interfaces only; no game or model execution. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const template = fs.readFileSync(path.join(__dirname, 'templates/localization.js'), 'utf8');
const config = {
  names: { '1': { name: { source: 'Default', target: 'Changed' } } },
  font: { file: 'fixture.ttf' },
  wrapMessages: true,
};

function actor() {
  function Actor(name) { this.value = name; }
  Actor.prototype.name = function () { return this.value; };
  Actor.prototype.actorId = function () { return 1; };
  return Actor;
}

function makeWindow(mz) {
  function Window() { this.drawn = ''; this.pause = false; this.contents = { height: 40, fontSize: 20 }; this.innerWidth = 60; }
  Window.prototype.textWidth = function (text) { return [...text].reduce((width, char) => width + (char === '宽' ? 120 : 10), 0) * this.contents.fontSize / 20; };
  Window.prototype.contentsWidth = () => 60;
  Window.prototype.newLineX = () => 0;
  Window.prototype.needsNewPage = function (state) { return state.index < state.text.length && state.y + 20 > 40; };
  Window.prototype.startPause = function () { this.pause = true; };
  Window.prototype.processNewLine = function (state) {
    state.x = 0;
    state.y += 20;
    if (!mz) state.index++;
    if (this.needsNewPage(state)) this.startPause();
  };
  if (mz) {
    Window.prototype.flushTextState = function (state) {
      this.drawn += state.buffer;
      state.x += this.textWidth(state.buffer);
      state.buffer = '';
    };
    Window.prototype.processCharacter = function (state) {
      const c = state.text[state.index++];
      if (c === '\n') { this.flushTextState(state); this.processNewLine(state); }
      else state.buffer += c;
    };
  } else {
    Window.prototype.processNormalCharacter = function (state) {
      this.drawn += state.text[state.index++];
      state.x += this.textWidth(state.text[state.index - 1]);
    };
    Window.prototype.processCharacter = function (state) {
      if (state.text[state.index] === '\n') this.processNewLine(state);
      else this.processNormalCharacter(state);
    };
  }
  return Window;
}

for (const mz of [false, true]) {
  const Actor = actor();
  const Window = makeWindow(mz);
  const context = {
    Game_Actor: Actor,
    Window_Message: Window,
    Game_System: function () {},
    Window_Base: function () {},
    FontManager: { load: () => {} },
  };
  context.Game_System.prototype.mainFontFace = () => 'original';
  context.Window_Base.prototype.standardFontFace = () => 'original';
  vm.runInNewContext(template.replace('__PINHAO_CONFIG__', JSON.stringify(config)), context);
  assert.equal(new Actor('Default').name(), 'Changed');
  assert.equal(new Actor('Personal name').name(), 'Personal name');
  assert.match(new context.Game_System().mainFontFace(), /PinHaoChinese/);

  for (const text of ['甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥', '123456\nabcdefg', 'short', '宽甲宽乙']) {
    const window = new Window();
    const state = { text, index: 0, x: 0, y: 0, startX: 0, buffer: '', height: 20 };
    let rounds = 0;
    while (state.index < text.length) {
      if (++rounds > 200) throw new Error('Message failed to finish');
      if (window.pause) { window.pause = false; state.y = 0; state.x = 0; }
      window.processCharacter(state);
      if (!window.pause) assert.ok(state.x <= 60, 'Message overflow');
      assert.equal(window.contents.fontSize, 20, 'Temporary glyph fitting changed the selected font size');
    }
    if (mz) window.flushTextState(state);
    assert.ok(state.x <= 60, 'Final message line overflow');
    assert.equal(window.drawn, text.replaceAll('\n', ''), `lost/duplicate text (${mz ? 'MZ' : 'MV'})`);
  }
}
console.log('MV/MZ default-name display, custom-name retention and message pagination passed');
