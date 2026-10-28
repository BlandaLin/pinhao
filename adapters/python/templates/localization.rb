# encoding: UTF-8
# PinHao Chinese display runtime; compatible with RGSS 1, 2 and 3 syntax.
module PinHaoLocalization
  CONFIG = __PINHAO_CONFIG__

  if CONFIG['font']
    begin
      register = Win32API.new('gdi32', 'AddFontResourceA', ['P'], 'I')
      register.call(CONFIG['font']['file'])
    rescue NameError, RuntimeError
    end
    Font.default_name = CONFIG['font']['family']
  end
end

class Game_Actor
  ['name', 'nickname', 'profile'].each do |field|
    next unless method_defined?(field)
    original = 'pinhao_original_' + field
    alias_method original, field unless method_defined?(original)
    define_method(field) do
      value = send(original)
      actor = PinHaoLocalization::CONFIG['names'][@actor_id.to_s]
      mapping = actor && actor[field]
      mapping && value == mapping['source'] ? mapping['target'] : value
    end
  end
end
