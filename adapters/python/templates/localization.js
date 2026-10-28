/* PinHao Chinese display runtime. Generated from an independent engine adapter. */
(function () {
  "use strict";
  var config = __PINHAO_CONFIG__;
  var face = "PinHaoChinese";

  if (config.font) {
    if (typeof FontManager !== "undefined" && FontManager.load) {
      FontManager.load(face, config.font.file);
    } else if (typeof Graphics !== "undefined" && Graphics.loadFont) {
      Graphics.loadFont(face, "fonts/" + config.font.file);
    }
    if (typeof Game_System !== "undefined" && Game_System.prototype.mainFontFace) {
      Game_System.prototype.mainFontFace = function () {
        return face + ", sans-serif";
      };
    }
    if (typeof Window_Base !== "undefined" && Window_Base.prototype.standardFontFace) {
      Window_Base.prototype.standardFontFace = function () {
        return face + ", sans-serif";
      };
    }
  }

  if (typeof Game_Actor !== "undefined") {
    ["name", "nickname", "profile"].forEach(function (field) {
      var original = Game_Actor.prototype[field];
      if (typeof original !== "function") return;
      Game_Actor.prototype[field] = function () {
        var value = original.apply(this, arguments);
        var actor = config.names[String(this.actorId())];
        var mapping = actor && actor[field];
        return mapping && value === mapping.source ? mapping.target : value;
      };
    });
  }

  if (config.wrapMessages && typeof Window_Message !== "undefined") {
    function fitFirstGlyph(window, character, available, draw) {
      var contents = window.contents;
      var size = contents && contents.fontSize;
      var width = window.textWidth(character);
      if (!(size > 0 && available > 0 && width > available)) return draw();
      contents.fontSize = Math.max(1, Math.floor(size * available / width));
      try { return draw(); } finally { contents.fontSize = size; }
    }
    if (Window_Message.prototype.processNormalCharacter) {
      var normalCharacter = Window_Message.prototype.processNormalCharacter;
      Window_Message.prototype.processNormalCharacter = function (state) {
        var character = state.text[state.index];
        var edge = this.contentsWidth();
        if (state.x > this.newLineX() && state.x + this.textWidth(character) > edge) {
          this.processNewLine(state);
          // processNewLine expects a consumed newline; the current character remains pending.
          state.index--;
          if (this.needsNewPage(state)) {
            return;
          }
        }
        var window = this;
        fitFirstGlyph(this, character, edge - state.x, function () {
          normalCharacter.call(window, state);
        });
      };
    } else if (Window_Message.prototype.processCharacter && Window_Message.prototype.flushTextState) {
      var processCharacter = Window_Message.prototype.processCharacter;
      Window_Message.prototype.processCharacter = function (state) {
        var character = state.text[state.index];
        var pending = state.buffer || "";
        if (!state.rtl && character && character.charCodeAt(0) >= 32 &&
            (state.x > state.startX || pending.length > 0) &&
            state.x + this.textWidth(pending + character) > this.innerWidth) {
          this.flushTextState(state);
          this.processNewLine(state);
          if (this.needsNewPage(state)) return;
          pending = state.buffer || "";
        }
        var window = this;
        if (!pending && character && character.charCodeAt(0) >= 32 &&
            this.textWidth(character) > this.innerWidth - state.x) {
          fitFirstGlyph(this, character, this.innerWidth - state.x, function () {
            processCharacter.call(window, state);
            window.flushTextState(state);
          });
        } else {
          processCharacter.call(this, state);
        }
      };
    }
  }
})();
