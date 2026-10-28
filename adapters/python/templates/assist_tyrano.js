var fs, path, config;
try {
    fs = typeof require === 'function' ? require('fs') : window.studio_api && window.studio_api.fs;
    path = typeof require === 'function' ? require('path') : window.studio_api && window.studio_api.path;
    if (!fs || !path) return;
    var env = typeof process === 'object' && process.env || {};
    config = { directory: env.PINHAO_ASSIST_DIR, token: env.PINHAO_ASSIST_TOKEN };
    if (!config.directory || !config.token) {
        var exe = typeof process === 'object' && process.execPath;
        if (!exe) return;
        config = JSON.parse(fs.readFileSync(path.join(path.dirname(exe), 'PinHao-assist-session.json'), 'utf8'));
    }
} catch (_) { return; }
if (!config.directory || !config.token) return;
var adapter = {
    engine: 'TyranoScript',
    kag: function() { return window.TYRANO && window.TYRANO.kag; },
    ready: function() { var kag = this.kag(); return Boolean(kag && kag.stat && kag.stat.f && kag.variable && kag.variable.sf); },
    identity: function() { var kag = this.kag(); return kag && kag.stat && kag.stat.f; },
    rows: function() {
        if (!this.ready()) return [];
        var kag = this.kag(), result = [];
        [['store', 'f', kag.stat.f], ['persistent', 'sf', kag.variable.sf]].forEach(function(entry) {
            Object.keys(entry[2]).sort().forEach(function(name) {
                if (name === '__proto__' || name === 'constructor' || name === 'prototype') return;
                var value = entry[2][name];
                result.push({ scope: entry[0], persistence: entry[0] === 'persistent' ? 'persistent' : 'game-save', store: entry[1], name: name, type: typeof value, value: value });
            });
        });
        return result;
    },
    write: function(row, value) {
        var kag = this.kag(), target = row.scope === 'persistent' ? kag.variable.sf : kag.stat.f;
        if (!Object.prototype.hasOwnProperty.call(target, row.name)) throw new Error('Refresh the variable list');
        var previous = target[row.name]; target[row.name] = value;
        if (row.scope === 'persistent') {
            try { kag.saveSystemVariable(); }
            catch (error) { target[row.name] = previous; throw error; }
        }
    }
};
var bridge = PinHaoScriptBridge(config, adapter, {
    read: function(name) { return fs.readFileSync(path.join(config.directory, name), 'utf8'); },
    write: function(name, value) {
        var target = path.join(config.directory, name), temporary = target + '.tmp';
        fs.writeFileSync(temporary, value, 'utf8'); fs.renameSync(temporary, target);
    }
});
setInterval(function() { try { bridge.poll(); } catch (_) {} }, 700);
