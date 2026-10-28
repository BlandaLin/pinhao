function PinHaoScriptBridge(config, adapter, io) {
    var completed = Object.create(null), order = [], session = '', identity;
    function reset() {
        session = String(Date.now()) + '-' + String(Math.random()).slice(2);
        completed = Object.create(null); order = [];
    }
    function scalar(value) {
        return typeof value === 'boolean' || typeof value === 'number' && isFinite(value) && Math.abs(value) <= 9007199254740991 || typeof value === 'string' && value.length <= 2000;
    }
    function tagged(hex) {
        if (!/^(?:[0-9a-f]{2})*$/i.test(hex)) throw new Error('Invalid command encoding');
        var raw = '', position = 0;
        for (var i = 0; i < hex.length; i += 2) raw += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
        function count(separator) {
            var end = raw.indexOf(separator, position);
            if (end < 0 || !/^\d+$/.test(raw.slice(position, end))) throw new Error('Invalid parameter length');
            var value = Number(raw.slice(position, end)); position = end + 1;
            if (value > 1048576) throw new Error('Parameter too large');
            return value;
        }
        function read(depth) {
            if (depth > 10) throw new Error('Parameters nested too deeply');
            var tag = raw.charAt(position++), end, value, length, result, key;
            if (tag === 'n') return null;
            if (tag === 't' || tag === 'f') return tag === 't';
            if (tag === 'd') {
                end = raw.indexOf(';', position); value = Number(raw.slice(position, end));
                if (end < 0 || !isFinite(value)) throw new Error('Invalid number');
                position = end + 1; return value;
            }
            length = count(':');
            if (tag === 's') {
                value = raw.slice(position, position + length); position += length;
                if (value.length !== length) throw new Error('Incomplete string');
                return decodeURIComponent(value.replace(/[\s\S]/g, function(c) { return '%' + ('0' + c.charCodeAt(0).toString(16)).slice(-2); }));
            }
            if (tag !== 'a' && tag !== 'o') throw new Error('Invalid parameter tag');
            result = tag === 'a' ? [] : Object.create(null);
            for (var index = 0; index < length; index++) {
                if (tag === 'a') result.push(read(depth + 1));
                else {
                    key = read(depth + 1);
                    if (typeof key !== 'string' || Object.prototype.hasOwnProperty.call(result, key)) throw new Error('Invalid parameter key');
                    result[key] = read(depth + 1);
                }
            }
            return result;
        }
        var value = read(0);
        if (position !== raw.length) throw new Error('Trailing parameter data');
        return value;
    }
    function poll() {
        var current = adapter.identity();
        if (current !== identity) { identity = current; reset(); }
        var results = [], rows = adapter.rows().filter(function(row) { return scalar(row.value); });
        var text = io.read('commands.txt').split(/\r?\n/);
        if (text[0] !== config.token) return;
        text.slice(1).forEach(function(line) {
            if (!line) return;
            var parts = line.split('\t'), id = parts[0];
            if (!completed[id]) {
                var result = { id: id };
                try {
                    if (parts.length !== 6 || parts[1] !== 'setNamedVariable' || parts[4] !== 'tagged') throw new Error('Select a named variable');
                    var payload = tagged(parts[5]), params = payload.params;
                    if (!params || params.gameSessionId !== session) throw new Error('Refresh variables after loading a save');
                    var row = rows.filter(function(item) { return item.scope === params.scope && (item.store || 'store') === (params.store || 'store') && item.name === params.name; })[0];
                    if (!row || !scalar(payload.value) || typeof payload.value !== row.type) throw new Error('Keep the selected variable type');
                    adapter.write(row, payload.value);
                } catch (error) { result.error = String(error.message || error); }
                completed[id] = result; order.push(id);
                if (order.length > 100) delete completed[order.shift()];
            }
            results.push(completed[id]);
        });
        io.write('state.json', JSON.stringify({ token: config.token, state: {
            ready: adapter.ready(), engine: adapter.engine, mode: 'live', actions: ['setNamedVariable'],
            gameSessionId: session, namedVariables: adapter.rows().filter(function(row) { return scalar(row.value); })
        }, results: results }));
    }
    reset();
    return { poll: poll, reset: reset };
}
