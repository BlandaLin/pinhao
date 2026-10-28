# encoding: UTF-8
# Optional live assistance for RGSS 1/2/3. Commands run on the game thread.
module PinHaoAssist
  ACTIONS = ['setGold', 'setItem', 'setSwitch', 'setVariable', 'heal',
             'setLevel', 'setExp', 'setHp', 'setMp', 'setThrough', 'setMoveSpeed',
             'setEncounter', 'jump', 'transfer', 'restoreMovement',
             'captureRecollection', 'applyRecollection', 'restoreRecollection']
  @completed = {}
  @order = []
  @sequence = 0
  @next_poll = 0
  @movement_applied = {}

  def self.decode_tagged(raw, offset = 0, depth = 0)
    raise 'Invalid assist parameters' if depth > 10 || offset >= raw.length
    tag = raw[offset, 1]
    return [nil, offset + 1] if tag == 'n'
    return [true, offset + 1] if tag == 't'
    return [false, offset + 1] if tag == 'f'
    if tag == 'd'
      finish = raw.index(';', offset + 1)
      raise 'Invalid assist number' unless finish
      text = raw[offset + 1, finish - offset - 1]
      raise 'Invalid assist number' unless text =~ /\A-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\z/
      return [text =~ /[.eE]/ ? text.to_f : text.to_i, finish + 1]
    end
    finish = raw.index(':', offset + 1)
    raise 'Invalid assist parameters' unless finish && raw[offset + 1, finish - offset - 1] =~ /\A\d{1,7}\z/
    count = raw[offset + 1, finish - offset - 1].to_i
    offset = finish + 1
    if tag == 's'
      raise 'Invalid assist text' if count > 1048576 || offset + count > raw.length
      value = raw[offset, count]
      value.force_encoding('UTF-8') if value.respond_to?(:force_encoding)
      return [value, offset + count]
    end
    raise 'Invalid assist collection' unless ['a', 'o'].include?(tag) && count <= 20000
    value = tag == 'a' ? [] : {}
    count.times do
      entry, offset = decode_tagged(raw, offset, depth + 1)
      if tag == 'a'
        value << entry
      else
        raise 'Invalid assist key' unless entry.is_a?(String)
        value[entry], offset = decode_tagged(raw, offset, depth + 1)
      end
    end
    [value, offset]
  end

  def self.api(name, args, result = 'L')
    Win32API.new('kernel32', name, args, result)
  end

  def self.byte_length(text)
    text.respond_to?(:bytesize) ? text.bytesize : text.length
  end

  def self.buffer(size)
    text = "\0" * size
    text.force_encoding('ASCII-8BIT') if text.respond_to?(:force_encoding)
    text
  end

  def self.utf8(text)
    text = text.to_s
    if text.respond_to?(:encode)
      begin
        candidate = text.dup.force_encoding('UTF-8')
        return candidate if candidate.valid_encoding?
        return text.encode('UTF-8')
      rescue StandardError
        return text.dup.force_encoding('Windows-31J').encode('UTF-8', :invalid => :replace, :undef => :replace)
      end
    end
    valid = /\A(?:[\x00-\x7f]|[\xc2-\xdf][\x80-\xbf]|[\xe0-\xef][\x80-\xbf]{2}|[\xf0-\xf4][\x80-\xbf]{3})*\z/n
    return text if valid.match(text)
    wide = buffer(text.length * 2 + 2)
    count = api('MultiByteToWideChar', ['L', 'L', 'P', 'L', 'P', 'L']).call(932, 0, text, text.length, wide, wide.length / 2)
    from_wide(wide, count)
  end

  def self.from_wide(wide, count)
    output = buffer(count * 4 + 1)
    size = api('WideCharToMultiByte', ['L', 'L', 'P', 'L', 'P', 'L', 'L', 'L']).call(65001, 0, wide, count, output, output.length, 0, 0)
    output[0, size]
  end

  def self.wide(text)
    length = byte_length(text)
    output = buffer(length * 2 + 2)
    count = api('MultiByteToWideChar', ['L', 'L', 'P', 'L', 'P', 'L']).call(65001, 0, text, length, output, output.length / 2)
    output[0, count * 2] + "\0\0"
  end

  def self.environment(name)
    return ENV[name] unless defined?(Win32API)
    output = buffer(65536)
    count = api('GetEnvironmentVariableW', ['P', 'P', 'L']).call(wide(name), output, output.length / 2)
    count > 0 && count < output.length / 2 ? from_wide(output, count) : nil
  end

  def self.read_file(path)
    return File.open(path, 'rb') { |file| file.read } unless defined?(Win32API)
    handle = api('CreateFileW', ['P', 'L', 'L', 'L', 'L', 'L', 'L']).call(wide(path), 0x80000000, 7, 0, 3, 0x80, 0)
    raise 'Assist input unavailable' if (handle & 0xffffffff) == 0xffffffff
    begin
      output = buffer(2 * 1024 * 1024)
      count = [0].pack('L')
      ok = api('ReadFile', ['L', 'P', 'L', 'P', 'L']).call(handle, output, output.length, count, 0)
      raise 'Assist input read failed' if ok == 0
      output[0, count.unpack('L')[0]]
    ensure
      api('CloseHandle', ['L']).call(handle)
    end
  end

  def self.write_file(path, text)
    return File.open(path, 'wb') { |file| file.write(text) } unless defined?(Win32API)
    handle = api('CreateFileW', ['P', 'L', 'L', 'L', 'L', 'L', 'L']).call(wide(path), 0x40000000, 7, 0, 2, 0x80, 0)
    raise 'Assist output unavailable' if (handle & 0xffffffff) == 0xffffffff
    begin
      count = [0].pack('L')
      length = byte_length(text)
      ok = api('WriteFile', ['L', 'P', 'L', 'P', 'L']).call(handle, text, length, count, 0)
      raise 'Assist output write failed' if ok == 0 || count.unpack('L')[0] != length
    ensure
      api('CloseHandle', ['L']).call(handle)
    end
  end

  def self.json(value)
    case value
    when Hash
      '{' + value.map { |key, item| json(key.to_s) + ':' + json(item) }.join(',') + '}'
    when Array
      '[' + value.map { |item| json(item) }.join(',') + ']'
    when String
      text = utf8(value)
      '"' + text.gsub(/["\\\x00-\x1f]/n) { |byte| '\\u%04x' % byte.unpack('C')[0] } + '"'
    when Numeric
      value.to_s
    when true
      'true'
    when false
      'false'
    else
      'null'
    end
  end

  def self.members
    $game_party.respond_to?(:members) ? $game_party.members : $game_party.actors
  end

  def self.actor_state(actor)
    hp_max = actor.respond_to?(:mhp) ? actor.mhp : actor.maxhp
    mp_max = actor.respond_to?(:mmp) ? actor.mmp : (actor.respond_to?(:maxmp) ? actor.maxmp : actor.maxsp)
    mp = actor.respond_to?(:mp) ? actor.mp : actor.sp
    maximum = actor.respond_to?(:max_level) ? actor.max_level : 99
    {'id' => actor.id, 'name' => actor.name, 'hp' => actor.hp, 'mp' => mp,
     'level' => actor.level, 'exp' => actor.exp, 'maxHp' => hp_max, 'maxMp' => mp_max, 'maxLevel' => maximum}
  end

  def self.ensure_session
    unless @game_identity.equal?($game_system)
      @game_identity = $game_system
      @game_session_id = Time.now.to_f.to_s + '-' + $game_system.object_id.to_s + '-' + rand(100000000).to_s
      @movement_original = nil
      @movement_applied = {}
      @recollection_backup = nil
      @recollection_result = nil
    end
  end

  def self.transferring?
    return $game_player.transfer? if $game_player.respond_to?(:transfer?)
    return $game_player.transferring? if $game_player.respond_to?(:transferring?)
    return $game_temp.player_transferring if $game_temp && $game_temp.respond_to?(:player_transferring)
    !!$game_player.instance_variable_get(:@transferring)
  end

  def self.movement
    return nil unless $game_player && $game_map && $game_map.respond_to?(:map_id)
    scene = defined?(SceneManager) && SceneManager.respond_to?(:scene) ? SceneManager.scene : $scene
    map_scene = defined?(Scene_Map) && scene.is_a?(Scene_Map)
    interpreter = $game_map.respond_to?(:interpreter) ? $game_map.interpreter : ($game_system.respond_to?(:map_interpreter) ? $game_system.map_interpreter : nil)
    busy = interpreter && interpreter.respond_to?(:running?) && interpreter.running?
    in_battle = $game_party.respond_to?(:in_battle) ? $game_party.in_battle : ($game_temp && $game_temp.respond_to?(:in_battle) && $game_temp.in_battle)
    {'through' => !!$game_player.instance_variable_get(:@through),
     'moveSpeed' => $game_player.instance_variable_get(:@move_speed),
     'encounterEnabled' => !$game_system.instance_variable_get(:@encounter_disabled),
     'mapId' => $game_map.map_id, 'mapName' => $game_map.respond_to?(:display_name) ? $game_map.display_name : '',
     'x' => $game_player.x, 'y' => $game_player.y, 'direction' => $game_player.direction,
     'canTransfer' => !!(map_scene && !busy && !in_battle && !transferring?),
     'modified' => !@movement_applied.empty?}
  end

  def self.set_movement(field, value, remember)
    current = movement
    raise 'Use movement assistance on the map' unless current
    if remember
      @movement_original ||= {}
      @movement_original[field] = current[field] unless @movement_original.has_key?(field)
      @movement_applied[field] = value
    end
    if field == 'through'
      $game_player.instance_variable_set(:@through, value)
    elsif field == 'moveSpeed'
      $game_player.instance_variable_set(:@move_speed, value)
    else
      $game_system.instance_variable_set(:@encounter_disabled, !value)
      $game_player.make_encounter_count if $game_player.respond_to?(:make_encounter_count)
    end
  end

  def self.validate_operation(operation)
    raise 'Invalid recollection recipe' unless operation.is_a?(Hash)
    kind, id, value = operation['type'], operation['id'], operation['value']
    return if kind == 'switch' && id.is_a?(Integer) && id > 0 && id < $data_system.switches.length && (value == true || value == false)
    return if kind == 'variable' && id.is_a?(Integer) && id > 0 && id < $data_system.variables.length && value.is_a?(Numeric) && ['set', 'min', 'max'].include?(operation['mode'] || 'set')
    return if kind == 'selfSwitch' && $game_self_switches && operation['mapId'].is_a?(Integer) && operation['mapId'] > 0 && operation['eventId'].is_a?(Integer) && operation['eventId'] > 0 && ['A', 'B', 'C', 'D'].include?(operation['key']) && (value == true || value == false)
    raise 'Recollection recipe does not match the game'
  end

  def self.read_operation(operation)
    case operation['type']
    when 'switch'; $game_switches[operation['id']]
    when 'variable'; $game_variables[operation['id']]
    when 'selfSwitch'; !!$game_self_switches[[operation['mapId'], operation['eventId'], operation['key']]]
    end
  end

  def self.write_operation(operation, value)
    case operation['type']
    when 'switch'; $game_switches[operation['id']] = value
    when 'variable'; $game_variables[operation['id']] = value
    when 'selfSwitch'; $game_self_switches[[operation['mapId'], operation['eventId'], operation['key']]] = value
    end
  end

  def self.applied_value(operation, original)
    return operation['value'] unless operation['type'] == 'variable'
    raise 'Recollection variable is not numeric' unless original.is_a?(Numeric)
    return [original, operation['value']].max if operation['mode'] == 'min'
    return [original, operation['value']].min if operation['mode'] == 'max'
    operation['value']
  end

  def self.recollection(action, params)
    if action == 'captureRecollection'
      operations = params['operations']
      raise 'Invalid recollection recipe' unless params['recipeId'].is_a?(String) && operations.is_a?(Array) && !operations.empty? && operations.length <= 10000
      operations.each { |operation| validate_operation(operation) }
      @recollection_backup = {'recipeId' => params['recipeId'], 'gameSessionId' => @game_session_id,
        'entries' => operations.map { |operation| original = read_operation(operation); {'operation' => operation, 'original' => original, 'applied' => applied_value(operation, original)} }}
      @recollection_result = {'action' => action, 'recipeId' => params['recipeId'], 'applied' => 0, 'restored' => 0, 'skipped' => 0}
      return
    end
    backup = params['backup']
    raise 'Confirm a recipe in the current save' unless backup.is_a?(Hash) && backup['gameSessionId'] == @game_session_id && backup['entries'].is_a?(Array) && !backup['entries'].empty? && backup['entries'].length <= 10000
    backup['entries'].each do |entry|
      operation = entry['operation']
      validate_operation(operation)
      original = entry['original']
      valid = operation['type'] == 'variable' ? original.is_a?(Numeric) : (original == true || original == false)
      raise 'Invalid recollection backup' unless valid && entry['applied'] == applied_value(operation, original)
      raise 'Game progress changed; confirm the recipe again' if action == 'applyRecollection' && read_operation(operation) != original
    end
    restored, skipped = 0, 0
    backup['entries'].each do |entry|
      if action == 'applyRecollection'
        write_operation(entry['operation'], entry['applied'])
      elsif read_operation(entry['operation']) == entry['applied']
        write_operation(entry['operation'], entry['original'])
        restored += 1
      else
        skipped += 1
      end
    end
    @recollection_backup = action == 'applyRecollection' ? backup : nil
    @recollection_result = {'action' => action, 'recipeId' => backup['recipeId'], 'applied' => action == 'applyRecollection' ? backup['entries'].length : 0, 'restored' => restored, 'skipped' => skipped}
  end

  def self.state
    ensure_session
    return {'ready' => false} unless $game_party && $game_system && $data_system && $game_map
    return {'ready' => false} if $scene && ['Scene_Title', 'Scene_Load', 'Scene_Boot'].include?($scene.class.to_s)
    return {'ready' => false} if defined?(SceneManager) && SceneManager.respond_to?(:scene) && SceneManager.scene && ['Scene_Title', 'Scene_Load'].include?(SceneManager.scene.class.to_s)
    items = []
    [['item', $data_items], ['weapon', $data_weapons], ['armor', $data_armors]].each do |kind, data|
      (data || []).each do |item|
        next unless item && item.name && item.name != ''
        count = if $game_party.respond_to?(:num_items)
          $game_party.num_items(item)
        else
          $game_party.send(kind + '_number', item.id)
        end
        items << {'id' => item.id, 'type' => kind, 'name' => item.name, 'count' => count}
      end
    end
    switches, variables = [], []
    ($data_system.switches || []).each_with_index do |name, id|
      switches << {'id' => id, 'name' => name.to_s.strip.empty? ? '开关 #' + id.to_s : name, 'value' => !!$game_switches[id]} if id > 0
    end
    ($data_system.variables || []).each_with_index do |name, id|
      value = $game_variables[id]
      if id > 0 && (value.is_a?(String) || value.is_a?(Numeric) || value == true || value == false)
        variables << {'id' => id, 'name' => name.to_s.strip.empty? ? '变量 #' + id.to_s : name, 'value' => value}
      end
    end
    actions = movement ? ACTIONS : ACTIONS - ['setThrough', 'setMoveSpeed', 'setEncounter', 'jump', 'transfer', 'restoreMovement']
    {'ready' => true, 'mode' => 'live', 'engine' => '__PINHAO_ENGINE__', 'actions' => actions,
     'gameSessionId' => @game_session_id, 'movement' => movement,
     'recollectionBackup' => @recollection_backup, 'recollectionResult' => @recollection_result,
     'gold' => $game_party.gold, 'items' => items, 'switches' => switches,
     'variables' => variables, 'actors' => members.map { |actor| actor_state(actor) }}
  end

  def self.execute(action, id, kind, value, params = {})
    raise 'Load or start a game first' unless state['ready']
    raise 'Refresh state for the current save' unless params.is_a?(Hash) && params['gameSessionId'] == @game_session_id
    case action
    when 'setGold'
      $game_party.gain_gold(value - $game_party.gold)
    when 'setItem'
      data = {'item' => $data_items, 'weapon' => $data_weapons, 'armor' => $data_armors}[kind]
      item = data && data[id]
      raise 'Item not found' unless item
      if $game_party.respond_to?(:num_items)
        $game_party.gain_item(item, value - $game_party.num_items(item))
      else
        $game_party.send('gain_' + kind, id, value - $game_party.send(kind + '_number', id))
      end
    when 'setSwitch', 'setVariable'
      data = action == 'setSwitch' ? $data_system.switches : $data_system.variables
      raise 'State ID not found' unless id > 0 && id < data.length
      action == 'setSwitch' ? $game_switches[id] = value : $game_variables[id] = value
    when 'heal'
      members.each { |actor| actor.recover_all }
    when 'setThrough'; set_movement('through', value, true)
    when 'setMoveSpeed'; set_movement('moveSpeed', value, true)
    when 'setEncounter'; set_movement('encounterEnabled', value, true)
    when 'restoreMovement'
      current = movement
      if @movement_original && current
        @movement_applied.each { |field, applied| set_movement(field, @movement_original[field], false) if current[field] == applied }
      end
      @movement_original, @movement_applied = nil, {}
    when 'jump'
      current = movement
      raise 'Jump from a freely controllable map' unless current && current['canTransfer']
      raise 'Jump target is outside the map' if $game_map.respond_to?(:valid?) && !$game_map.valid?($game_player.x + params['dx'], $game_player.y + params['dy'])
      $game_player.jump(params['dx'], params['dy'])
    when 'transfer'
      current = movement
      raise 'Transfer from a freely controllable map' unless current && current['canTransfer']
      direction = params['direction'] || 0
      if $game_player.respond_to?(:reserve_transfer)
        $game_player.reserve_transfer(params['mapId'], params['x'], params['y'], direction)
      else
        $game_temp.player_new_map_id = params['mapId']
        $game_temp.player_new_x = params['x']
        $game_temp.player_new_y = params['y']
        $game_temp.player_new_direction = direction == 0 ? $game_player.direction : direction
        $game_temp.player_transferring = true
      end
    when 'captureRecollection', 'applyRecollection', 'restoreRecollection'
      recollection(action, params)
    when 'setLevel', 'setExp', 'setHp', 'setMp'
      actor = members.find { |member| member.id == id }
      raise 'Party actor not found' unless actor
      if action == 'setLevel'
        actor.respond_to?(:change_level) ? actor.change_level(value, false) : actor.level = value
      elsif action == 'setExp'
        actor.respond_to?(:change_exp) ? actor.change_exp(value, false) : actor.exp = value
      elsif action == 'setHp'
        actor.hp = value
      else
        actor.respond_to?(:mp=) ? actor.mp = value : actor.sp = value
      end
    else
      raise 'Unknown assist action'
    end
    $game_map.need_refresh = true if $game_map.respond_to?(:need_refresh=)
  end

  def self.poll
    return unless @directory && @token
    now = Time.now.to_f
    return if now < @next_poll
    @next_poll = now + 0.5
    begin
      lines = read_file(@directory + '/commands.txt').split("\n")
      return unless lines.shift == @token
      lines.each do |line|
        parts = line.split("\t", -1)
        next unless parts.length == 6 && parts[0] =~ /\A[\w-]{1,80}\z/ && ACTIONS.include?(parts[1])
        command_id, action, target, kind, value_type, raw = parts
        next if @completed[command_id]
        result = {'id' => command_id}
        begin
          value, params = [raw].pack('H*'), {}
          if value_type == 'tagged'
            envelope, consumed = decode_tagged(value)
            raise 'Invalid assist parameters' unless consumed == value.length && envelope.is_a?(Hash)
            value, params = envelope['value'], envelope['params'] || {}
          else
            value = action == 'setVariable' && value =~ /[.eE]/ ? value.to_f : value.to_i if value_type == 'number'
            value = value == 'true' if value_type == 'boolean'
            value.force_encoding('UTF-8') if value.is_a?(String) && value.respond_to?(:force_encoding)
          end
          execute(action, target.to_i, kind, value, params)
          if action == 'transfer'
            result['waitTransfer'], result['deadline'] = params, now + 20
          end
        rescue StandardError => error
          result['error'] = error.message
        end
        @completed[command_id] = result
        @order << command_id
        @completed.delete(@order.shift) if @order.length > 100
      end
      @order.each do |id|
        result = @completed[id]
        target = result['waitTransfer']
        next unless target
        arrived = $game_map.map_id == target['mapId'] && $game_player.x == target['x'] && $game_player.y == target['y'] && !transferring?
        if arrived || now > result['deadline']
          result.delete('waitTransfer')
          result.delete('deadline')
          result['error'] = 'Map transfer did not complete' unless arrived
        end
      end
      @sequence += 1
      write_file(@directory + '/state.json', json({'token' => @token, 'sequence' => @sequence, 'state' => state, 'results' => @order.map { |id| @completed[id] }.reject { |result| result['waitTransfer'] }}))
    rescue StandardError
      # A closing desktop session leaves the game running normally.
    end
  end

  @directory = environment('PINHAO_ASSIST_DIR')
  @token = environment('PINHAO_ASSIST_TOKEN')
end

class << Graphics
  unless method_defined?(:pinhao_assist_original_update)
    alias_method :pinhao_assist_original_update, :update
    def update
      pinhao_assist_original_update
      PinHaoAssist.poll
    end
  end
end
