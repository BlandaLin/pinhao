extends Node

var directory = ""
var token = ""
var session = ""
var scene_id = 0
var elapsed = 0.0
var completed = {}
var completed_order = []
var cursor = 0
var raw = []

func _ready():
	directory = OS.get_environment("PINHAO_ASSIST_DIR")
	token = OS.get_environment("PINHAO_ASSIST_TOKEN")
	if directory.empty() or token.empty():
		set_process(false)
		return
	__PINHAO_PAUSE_MODE__
	reset_session()
	set_process(true)

func reset_session():
	session = str(OS.get_unix_time()) + "-" + str(OS.get_ticks_usec()) + "-" + str(randi())
	completed = {}
	completed_order = []

func scalar_type(value):
	if typeof(value) == TYPE_BOOL:
		return "boolean"
	if typeof(value) == TYPE_INT or typeof(value) == TYPE_REAL:
		if abs(value) <= 9007199254740991.0 and not is_nan(float(value)) and not is_inf(float(value)):
			return "number"
	if typeof(value) == TYPE_STRING and value.length() <= 2000:
		return "string"
	return ""

func variables():
	var rows = []
	var pending = [get_tree().get_root()]
	while pending.size():
		var node = pending[pending.size() - 1]
		pending.pop_back()
		for child in node.get_children():
			if child != self and not str(child.name).begins_with("PinHao"):
				pending.append(child)
		if node == self or node.get_script() == null:
			continue
		for item in node.get_property_list():
			var key = str(item.name)
			if (int(item.usage) & PROPERTY_USAGE_SCRIPT_VARIABLE) == 0 or key.begins_with("_"):
				continue
			var value = node.get(key)
			var kind = scalar_type(value)
			if kind != "":
				rows.append({"scope":"store", "persistence":"unknown", "store":str(node.get_path()), "name":key, "type":kind, "value":value})
	return rows

func count_value(separator):
	var number = ""
	while cursor < raw.size() and raw[cursor] != separator:
		if raw[cursor] < 48 or raw[cursor] > 57:
			return -1
		number += char(raw[cursor])
		cursor += 1
	if cursor >= raw.size() or number.empty() or number.length() > 7:
		return -1
	cursor += 1
	return int(number)

func read_tag(depth):
	if depth > 10 or cursor >= raw.size():
		return {"error":"Invalid parameter nesting"}
	var tag = char(raw[cursor])
	cursor += 1
	if tag == "n":
		return {"value":null}
	if tag == "t" or tag == "f":
		return {"value":tag == "t"}
	if tag == "d":
		var text = ""
		while cursor < raw.size() and raw[cursor] != 59:
			text += char(raw[cursor])
			cursor += 1
		if cursor >= raw.size() or not text.is_valid_float():
			return {"error":"Invalid numeric value"}
		cursor += 1
		return {"value":float(text)}
	var length = count_value(58)
	if length < 0 or length > 1048576:
		return {"error":"Invalid parameter length"}
	if tag == "s":
		if cursor + length > raw.size():
			return {"error":"Incomplete parameter string"}
		var bytes = __PINHAO_BYTE_ARRAY__()
		for index in range(length):
			bytes.append(raw[cursor + index])
		cursor += length
		return {"value":bytes.get_string_from_utf8()}
	if tag != "o" and tag != "a":
		return {"error":"Invalid parameter tag"}
	var values = {} if tag == "o" else []
	for _index in range(length):
		var key = null
		if tag == "o":
			var decoded = read_tag(depth + 1)
			if decoded.has("error"):
				return decoded
			key = decoded.value
			if typeof(key) != TYPE_STRING or values.has(key):
				return {"error":"Invalid parameter key"}
		var child = read_tag(depth + 1)
		if child.has("error"):
			return child
		if tag == "o":
			values[key] = child.value
		else:
			values.append(child.value)
	return {"value":values}

func execute(parts, rows):
	if parts.size() != 6 or parts[1] != "setNamedVariable" or parts[4] != "tagged":
		return "Select a named variable"
	var hex = parts[5]
	if hex.length() % 2 or not hex.is_valid_hex_number():
		return "Invalid command encoding"
	raw = []
	for index in range(0, hex.length(), 2):
		raw.append(("0x" + hex.substr(index, 2)).hex_to_int())
	cursor = 0
	var payload = read_tag(0)
	if payload.has("error") or cursor != raw.size():
		return "Invalid command parameters"
	var value = payload.value
	if typeof(value) != TYPE_DICTIONARY or not value.has("params") or not value.has("value"):
		return "Invalid variable command"
	var params = value.params
	if typeof(params) != TYPE_DICTIONARY or params.get("gameSessionId", "") != session:
		return "Refresh variables after changing scenes"
	for row in rows:
		if params.get("scope", "") == "store" and params.get("store", "") == row.store and params.get("name", "") == row.name:
			if scalar_type(value.value) != row.type:
				return "Keep the selected variable type"
			var node = get_node_or_null(row.store)
			if node == null:
				return "Refresh the variable list"
			var original = node.get(row.name)
			if typeof(original) == TYPE_INT and float(value.value) != int(value.value):
				return "Enter an integer for this property"
			node.set(row.name, int(value.value) if typeof(original) == TYPE_INT else value.value)
			return ""
	return "Select an existing variable"

func _process(delta):
	elapsed += delta
	if elapsed < 0.7:
		return
	elapsed = 0.0
	var scene = get_tree().current_scene
	var current = scene.get_instance_id() if scene else 0
	if current != scene_id:
		scene_id = current
		reset_session()
	var text = __PINHAO_READ_FILE__
	var lines = text.split("\n")
	if lines.size() == 0 or lines[0].strip_edges() != token:
		return
	var rows = variables()
	var results = []
	for line in lines:
		if line == lines[0] or line.empty():
			continue
		var parts = line.strip_edges().split("\t", true)
		var command_id = parts[0]
		if not completed.has(command_id):
			var result = {"id":command_id}
			var error = execute(parts, rows)
			if error != "":
				result.error = error
			completed[command_id] = result
			completed_order.append(command_id)
			if completed_order.size() > 100:
				completed.erase(completed_order[0])
				completed_order.pop_front()
		results.append(completed[command_id])
	var payload = {"token":token, "state":{"ready":scene != null, "engine":"Godot", "mode":"live", "actions":["setNamedVariable"], "gameSessionId":session, "namedVariables":variables()}, "results":results}
	__PINHAO_WRITE_FILE__
