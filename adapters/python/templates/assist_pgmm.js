var bridge = null, elapsed = 0;
var definitions = __PINHAO_DEFINITIONS__;
function start() {
    if (typeof jsb !== 'object' || !jsb.fileUtils || typeof Agtk !== 'object') return;
    var files = jsb.fileUtils, config;
    var paths = [Agtk.settings.projectPath + '/PinHao-assist-session.json', Agtk.settings.projectPath + '/../PinHao-assist-session.json', 'PinHao-assist-session.json'];
    for (var i = 0; i < paths.length; i++) {
        try { config = JSON.parse(files.getStringFromFile(paths[i])); if (config.directory && config.token) break; } catch (_) {}
    }
    if (!config || !config.directory || !config.token) return;
    var adapter = {
        engine: 'Pixel Game Maker MV',
        ready: function() { return Boolean(Agtk.sceneInstances.getCurrent()); },
        identity: function() { var scene = Agtk.sceneInstances.getCurrent(); return scene && scene.sceneId; },
        rows: function() {
            if (!this.ready()) return [];
            var result = [];
            definitions.forEach(function(item) {
                var variable = Agtk[item.store].get(item.id);
                if (!variable) return;
                var value = variable.getValue();
                result.push({ scope: 'store', store: item.store, name: String(item.id) + ':' + item.name, type: typeof value, value: value });
            });
            return result;
        },
        write: function(row, value) {
            var definition = definitions.filter(function(item) { return item.store === row.store && String(item.id) + ':' + item.name === row.name; })[0];
            if (!definition) throw new Error('Refresh the variable list');
            Agtk[definition.store].get(definition.id).setValue(value);
        }
    };
    bridge = PinHaoScriptBridge(config, adapter, {
        read: function(name) { return files.getStringFromFile(config.directory.replace(/\\/g, '/') + '/' + name); },
        write: function(name, value) {
            var base = config.directory.replace(/\\/g, '/') + '/', temporary = base + name + '.tmp';
            if (!files.writeStringToFile(value, temporary)) throw new Error('Assist state write failed');
            if (files.isFileExist(base + name)) files.removeFile(base + name);
            if (!files.renameFile(temporary, base + name)) throw new Error('Assist state write failed');
        }
    });
}
return {
    getInfo: function(category) {
        if (category === 'name') return 'PinHao play assistance';
        if (category === 'author') return 'PinHao';
        if (category === 'internal') return null;
        if (category === 'parameter' || category === 'actionCommand' || category === 'linkCondition') return [];
        return '';
    },
    setLocale: function() {}, call: function() {},
    initialize: function() { try { start(); } catch (_) {} },
    setInternal: function() { if (bridge) bridge.reset(); },
    finalize: function() { bridge = null; },
    update: function(delta) {
        elapsed += delta;
        if (elapsed < 0.7) return;
        elapsed = 0;
        try { if (bridge) bridge.poll(); } catch (_) {}
    }
};
