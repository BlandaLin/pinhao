/* Original database names for proven logic consumers; normal display getters remain unchanged. */
var PinHaoNameIdentity = (function () {
  "use strict";
  var config = __PINHAO_IDENTITY_CONFIG__;
  function dataName(table, record) {
    var current = record.name;
    var rows = config.tables[table];
    var mapping = rows && rows[String(record.id)];
    return mapping && current === mapping.target ? mapping.source : current;
  }
  return {
    dataName: dataName,
    battlerName: function (table, battler) {
      var current = battler.name();
      if (table !== "Enemies" || !config.enemyNativeVerified) return current;
      var record = battler.enemy();
      var base = record.name;
      var suffix = battler._plural ? battler._letter : "";
      return current === base + suffix ? dataName(table, record) + suffix : current;
    },
    typeNames: function (field, current) {
      var rows = config.types[field];
      return current.map(function (value, index) {
        var mapping = rows && rows[String(index)];
        return mapping && value === mapping.target ? mapping.source : value;
      });
    }
  };
})();
