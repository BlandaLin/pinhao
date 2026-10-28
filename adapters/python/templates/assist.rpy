# Pinhao play assistance. Activation uses the workbench launch environment.
init 999 python hide:
    def _pinhao_assist_boot():
        import ast
        import binascii
        import json
        import math
        import os
        import time
        import uuid
        import renpy

        directory = os.environ.get('PINHAO_ASSIST_DIR')
        token = os.environ.get('PINHAO_ASSIST_TOKEN')
        if not directory or not token:
            return
        try:
            text_types = (basestring,)
            integer_types = (int, long)
        except NameError:
            text_types = (str,)
            integer_types = (int,)

        def scalar_type(value):
            if type(value) is bool:
                return 'boolean'
            if isinstance(value, integer_types + (float,)) and not isinstance(value, bool):
                if abs(value) <= 9007199254740991 and not math.isnan(value) and not math.isinf(value):
                    return 'number'
            if isinstance(value, text_types) and len(value) <= 2000:
                return 'string'
            return None

        def decode_tagged(raw):
            cursor = [0]
            def count(separator):
                end = raw.index(separator, cursor[0])
                value = int(raw[cursor[0]:end])
                cursor[0] = end + 1
                if value < 0 or value > 1048576:
                    raise ValueError('Invalid parameter length')
                return value
            def read(depth=0):
                if depth > 10:
                    raise ValueError('Parameters nested too deeply')
                tag = raw[cursor[0]:cursor[0] + 1]
                cursor[0] += 1
                if tag == b'n':
                    return None
                if tag in (b't', b'f'):
                    return tag == b't'
                if tag == b'd':
                    end = raw.index(b';', cursor[0])
                    value = raw[cursor[0]:end].decode('ascii')
                    cursor[0] = end + 1
                    return float(value) if any(c in value for c in '.eE') else int(value)
                if tag == b's':
                    length = count(b':')
                    value = raw[cursor[0]:cursor[0] + length]
                    cursor[0] += length
                    if len(value) != length:
                        raise ValueError('Incomplete string')
                    return value.decode('utf-8')
                if tag in (b'a', b'o'):
                    length = count(b':')
                    if tag == b'a':
                        return [read(depth + 1) for _ in range(length)]
                    result = {}
                    for _ in range(length):
                        key = read(depth + 1)
                        if not isinstance(key, text_types) or key in result:
                            raise ValueError('Invalid parameter key')
                        result[key] = read(depth + 1)
                    return result
                raise ValueError('Invalid parameter tag')
            result = read()
            if cursor[0] != len(raw):
                raise ValueError('Unexpected parameter suffix')
            return result

        class Bridge(object):
            def __init__(self):
                self.last_poll = 0
                self.session = uuid.uuid4().hex
                self.completed = {}
                self.completed_order = []
                self.declarations = None

            def reset(self):
                # Default processing runs on new games, save loads and rollback.
                self.session = uuid.uuid4().hex
                self.completed = {}
                self.completed_order = []

            def catalog(self):
                if self.declarations is not None:
                    return self.declarations
                declarations = set()
                files = set(name.replace('\\', '/').replace('.rpyc', '.rpy') for name in renpy.exports.list_files() if name.endswith(('.rpy', '.rpyc')))
                reserved_stores = ('store.config', 'store.gui', 'store.preferences', 'store.audio', 'store.achievement', 'store.build')
                def add(store, name):
                    if not isinstance(name, text_types) or not name or name.startswith('_') or '.' in name:
                        return
                    if store == 'store.persistent':
                        declarations.add(('persistent', '', name))
                    elif store == 'store' or store.startswith('store.') and not any(store == item or store.startswith(item + '.') for item in reserved_stores):
                        if all(part and not part.startswith('_') for part in store.split('.')):
                            declarations.add(('store', store, name))
                def target(store, item):
                    if isinstance(item, ast.Name):
                        add(store, item.id)
                    elif isinstance(item, ast.Attribute) and isinstance(item.value, ast.Name) and item.value.id == 'persistent':
                        add('store.persistent', item.attr)
                    elif isinstance(item, (ast.Tuple, ast.List)):
                        for child in item.elts:
                            target(store, child)
                for node in renpy.game.script.all_stmts or []:
                    filename = getattr(node, 'filename', '').replace('\\', '/').replace('.rpyc', '.rpy')
                    if filename.endswith('/zz_pinhao_assist.rpy') or filename == 'zz_pinhao_assist.rpy':
                        continue
                    if '/renpy/common/' in filename or filename.startswith(('renpy/common/', 'common/')):
                        continue
                    if not any(filename == name or filename.endswith('/' + name) or filename == 'game/' + name for name in files):
                        continue
                    store = getattr(node, 'store', 'store')
                    if isinstance(node, renpy.ast.Default):
                        add(store, node.varname)
                    elif isinstance(node, renpy.ast.Python) and not node.hide:
                        source = getattr(node.code, 'source', None)
                        if not isinstance(source, text_types):
                            continue
                        try:
                            tree = ast.parse(source)
                        except (SyntaxError, ValueError, TypeError):
                            continue
                        # Walk control-flow statements, leaving function/class locals alone.
                        pending = list(tree.body)
                        while pending:
                            statement = pending.pop()
                            if isinstance(statement, (ast.FunctionDef, ast.ClassDef, ast.Lambda)):
                                continue
                            if isinstance(statement, ast.Assign):
                                for item in statement.targets:
                                    target(store, item)
                            elif isinstance(statement, ast.AugAssign):
                                target(store, statement.target)
                            elif hasattr(ast, 'AnnAssign') and isinstance(statement, ast.AnnAssign):
                                target(store, statement.target)
                            for field in ('body', 'orelse', 'finalbody'):
                                pending.extend(getattr(statement, field, []))
                            for handler in getattr(statement, 'handlers', []):
                                pending.extend(handler.body)
                self.declarations = sorted(declarations)
                return self.declarations

            def variables(self):
                rows = []
                for scope, store, name in self.catalog():
                    if scope == 'persistent':
                        values = vars(renpy.store.persistent)
                    else:
                        values = renpy.python.store_dicts.get(store, {})
                        if values.get('_constant', False):
                            continue
                    if name not in values:
                        continue
                    value = values[name]
                    kind = scalar_type(value)
                    if kind:
                        row = {'scope': scope, 'persistence': 'persistent' if scope == 'persistent' else 'game-save', 'name': name, 'type': kind, 'value': value}
                        if scope == 'store':
                            row['store'] = store
                        rows.append(row)
                return rows

            def execute(self, action, payload):
                if action != 'setNamedVariable' or not isinstance(payload, dict):
                    raise ValueError('Select a supported variable action')
                params, value = payload.get('params', {}), payload.get('value')
                if not isinstance(params, dict) or params.get('gameSessionId') != self.session:
                    raise ValueError('Refresh variables after loading or rolling back')
                key = (params.get('scope'), params.get('store', 'store') if params.get('scope') == 'store' else '', params.get('name'))
                row = next((item for item in self.variables() if (item['scope'], item.get('store', ''), item['name']) == key), None)
                if not row or scalar_type(value) != row['type']:
                    raise ValueError('Keep the selected variable type')
                if row['scope'] == 'persistent':
                    setattr(renpy.store.persistent, row['name'], value)
                    renpy.exports.save_persistent()
                else:
                    renpy.exports.retain_after_load()
                    renpy.python.store_dicts[row['store']][row['name']] = value
                renpy.exports.restart_interaction()

            def poll(self):
                now = time.time()
                if now - self.last_poll < 0.35:
                    return
                self.last_poll = now
                results = []
                try:
                    with open(os.path.join(directory, 'commands.txt'), 'rb') as stream:
                        lines = stream.read(1048577).splitlines()
                    if not lines or lines[0].decode('ascii') != token:
                        return
                    for line in lines[1:]:
                        columns = line.split(b'\t')
                        if len(columns) != 6:
                            continue
                        command_id = columns[0].decode('ascii')
                        result = self.completed.get(command_id)
                        if result is None:
                            result = {'id': command_id}
                            try:
                                if columns[4] != b'tagged':
                                    raise ValueError('Use typed variable parameters')
                                self.execute(columns[1].decode('ascii'), decode_tagged(binascii.unhexlify(columns[5])))
                            except Exception as error:
                                result['error'] = str(error)
                            self.completed[command_id] = result
                            self.completed_order.append(command_id)
                            if len(self.completed_order) > 100:
                                self.completed.pop(self.completed_order.pop(0), None)
                        results.append(result)
                    ready = not bool(getattr(renpy.store, 'main_menu', True))
                    state = {'ready': ready, 'engine': "Ren'Py", 'mode': 'live', 'actions': ['setNamedVariable'],
                             'gameSessionId': self.session, 'namedVariables': self.variables() if ready else []}
                    raw = json.dumps({'token': token, 'state': state, 'results': results}, ensure_ascii=True, allow_nan=False).encode('utf-8')
                    temporary = os.path.join(directory, 'state.tmp')
                    with open(temporary, 'wb') as stream:
                        stream.write(raw)
                    # Windows rename requires removing the previous snapshot first.
                    destination = os.path.join(directory, 'state.json')
                    if os.path.exists(destination):
                        os.remove(destination)
                    os.rename(temporary, destination)
                except (IOError, OSError, ValueError):
                    pass

        bridge = Bridge()
        renpy.config.periodic_callbacks.append(bridge.poll)
        renpy.config.after_default_callbacks.append(bridge.reset)
        renpy.config.after_load_callbacks.append(bridge.reset)
        renpy.config.start_callbacks.append(bridge.reset)

    _pinhao_assist_boot()
