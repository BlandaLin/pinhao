import path from 'node:path';

export const JSON_FIELD_POLICY_VERSION = 'pinhao-json-field-policy-5';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const at = (root, parts) => parts.reduce((value, part) => value && typeof value === 'object' && Object.hasOwn(value, part) ? value[part] : undefined, root);
const index = value => /^(?:0|[1-9]\d*)$/.test(String(value));
const pointerFor = parts => '/' + parts.map(part => String(part).replaceAll('~', '~0').replaceAll('/', '~1')).join('/');

function profileFor(file, value) {
  const name = path.posix.basename(String(file).replaceAll('\\', '/'));
  if (/^Map\d+\.json$/i.test(name) && record(value) && Number.isInteger(value.width) && Number.isInteger(value.height)
      && Array.isArray(value.data) && Array.isArray(value.events)) return 'map';
  if (/^MapInfos\.json$/i.test(name) && Array.isArray(value)) return 'map-infos';
  if (/^CommonEvents\.json$/i.test(name) && Array.isArray(value)) return 'common-events';
  if (/^Troops\.json$/i.test(name) && Array.isArray(value)) return 'troops';
  if (/^(?:Skills|Items)\.json$/i.test(name) && Array.isArray(value)) return 'usable-items';
  if (/^System\.json$/i.test(name) && record(value) && record(value.terms) && Array.isArray(value.switches)
      && Array.isArray(value.variables)) return 'system';
}

function commandAt(profile, root, parts) {
  const parameter = parts.lastIndexOf('parameters');
  if (parameter < 0 || !index(parts[parameter + 1])) return;
  const prefix = parts.slice(0, parameter);
  const shape = profile === 'map' ? /^events\/\d+\/pages\/\d+\/list\/\d+$/
    : profile === 'common-events' ? /^\d+\/list\/\d+$/ : profile === 'troops' ? /^\d+\/pages\/\d+\/list\/\d+$/ : undefined;
  if (!shape?.test(prefix.join('/'))) return;
  const command = at(root, prefix);
  if (!record(command) || !Number.isInteger(command.code) || !Array.isArray(command.parameters)) return;
  return { command, parameter: Number(parts[parameter + 1]), tail: parts.slice(parameter + 2), prefix };
}

const audio = value => record(value) && typeof value.name === 'string'
  && ['volume', 'pitch', 'pan'].every(key => typeof value[key] === 'number');
const evidence = (parts, rule, consumer, classification = 'resource_identity') => ({
  classification, rule, path: parts, pointer: pointerFor(parts), evidence: 'rpgmaker-native-field-consumer', consumer,
});

/** Proven whole-field identities in the mature MV/MZ data format, not a name/word blacklist. */
export function jsonFieldIdentity(file, document, inputParts) {
  const parts = inputParts.map(String), profile = profileFor(file, document);
  if (!profile || typeof at(document, parts) !== 'string') return;
  const joined = parts.join('/');
  if (profile === 'map-infos' && /^\d+\/name$/.test(joined)) {
    const owner = at(document, parts.slice(0, -1));
    if (record(owner) && owner.id === Number(parts[0]) && Number.isInteger(owner.parentId) && Number.isInteger(owner.order)
        && typeof owner.expanded === 'boolean' && typeof owner.scrollX === 'number' && typeof owner.scrollY === 'number') {
      return evidence(parts, 'rpg-editor-map-identity', 'MapInfos editor/debug name; Window_MapName reads Game_Map.displayName from Map.displayName instead', 'logic_identity');
    }
  }
  if (profile === 'usable-items' && /^\d+\/damage\/formula$/.test(joined)) {
    const owner = at(document, parts.slice(0, -2)), damage = owner?.damage;
    if (record(owner) && Number.isInteger(owner.id) && record(damage) && Number.isInteger(damage.type)
        && Number.isInteger(damage.elementId) && typeof damage.variance === 'number' && typeof damage.critical === 'boolean') {
      return evidence(parts, 'rpg-damage-formula', 'Game_Action.evalDamageFormula: eval(item.damage.formula)', 'logic_identity');
    }
  }
  if (profile === 'map') {
    if (/^(?:bgm|bgs)\/name$/.test(joined) && audio(at(document, parts.slice(0, -1)))) {
      return evidence(parts, 'rpg-map-audio-resource', `AudioManager.play${parts[0] === 'bgm' ? 'Bgm' : 'Bgs'}: buffer filename and current-track identity`);
    }
    if (/^(?:parallaxName|battleback1Name|battleback2Name)$/.test(joined)) return evidence(parts, 'rpg-map-image-resource', 'Game_Map / ImageManager: parallax or battleback filename');
    if (/^events\/\d+\/pages\/\d+\/image\/characterName$/.test(joined)
        && record(at(document, parts.slice(0, -1))) && Number.isInteger(at(document, parts.slice(0, -1)).characterIndex)) {
      return evidence(parts, 'rpg-event-character-resource', 'Game_Event.setupPageSettings / ImageManager: character filename');
    }
    if (/^events\/\d+\/name$/.test(joined)) {
      const event = at(document, parts.slice(0, -1));
      if (record(event) && Number.isInteger(event.id) && Number.isInteger(event.x) && Number.isInteger(event.y) && Array.isArray(event.pages)) {
        return evidence(parts, 'rpg-editor-event-identity', 'RPG Map event record: editor/event identity, not an actor display-name field', 'logic_identity');
      }
    }
  }
  if (profile === 'system') {
    if (/^battleback[12]Name$/.test(joined)) return evidence(parts, 'rpg-system-battleback-resource', 'Spriteset_Battle.battleback1Name/battleback2Name / ImageManager: battle-test background filename');
    if (joined === 'locale') return evidence(parts, 'rpg-system-language-config', 'Game_System.isJapanese/isChinese/isKorean/isCJK/isRussian: locale prefix controls runtime language branches', 'logic_identity');
    const parent = at(document, parts.slice(0, -1));
    if (/^(?:titleBgm|battleBgm|victoryMe|defeatMe)\/name$/.test(joined) && audio(parent)
        || /^sounds\/\d+\/name$/.test(joined) && audio(parent)
        || /^(?:boat|ship|airship)\/bgm\/name$/.test(joined) && audio(parent)) {
      return evidence(parts, 'rpg-system-audio-resource', 'AudioManager: configured audio buffer filename');
    }
    if (/^title[12]Name$/.test(joined) || /^(?:boat|ship|airship)\/characterName$/.test(joined)) return evidence(parts, 'rpg-system-image-resource', 'Scene_Title / Game_Vehicle / ImageManager: image filename');
  }
  if (profile === 'common-events' && /^\d+\/name$/.test(joined)) {
    const event = at(document, parts.slice(0, -1));
    if (record(event) && Number.isInteger(event.id) && Array.isArray(event.list)) return evidence(parts, 'rpg-editor-common-event-identity', 'RPG common-event record: editor/event identity, not a message field', 'logic_identity');
  }
  const location = commandAt(profile, document, parts);
  if (location) {
    const { command, parameter, tail } = location;
    if ([241, 245, 249, 250].includes(command.code) && parameter === 0 && tail.join('/') === 'name' && audio(command.parameters[0])) {
      return evidence(parts, 'rpg-command-audio-resource', `Game_Interpreter.command${command.code} / AudioManager: audio filename`);
    }
    const imageParameters = { 101: [0], 231: [1], 283: [0, 1], 284: [0], 322: [1, 3, 5], 323: [1] };
    if (!tail.length && imageParameters[command.code]?.includes(parameter)) return evidence(parts, 'rpg-command-image-resource', `Game_Interpreter.command${command.code} / ImageManager: image filename`);
    if (!tail.length && parameter === 0 && [355, 655, 356].includes(command.code)) {
      return evidence(parts, 'rpg-command-program', `Game_Interpreter.command${command.code}: executable script or plugin-command syntax`, 'logic_identity');
    }
    if (!tail.length && parameter === 0 && [108, 408].includes(command.code)) return evidence(parts, 'rpg-command-comment-container', 'Game_Interpreter.command108: comment/source container, not a display-text parameter', 'logic_identity');
    if (!tail.length && parameter === 0 && [118, 119, 123].includes(command.code)) return evidence(parts, 'rpg-command-control-identity', `Game_Interpreter.command${command.code}: label or self-switch identity`, 'logic_identity');
    if (!tail.length && command.code === 111 && parameter === 1 && [11, 12].includes(command.parameters[0])) return evidence(parts, 'rpg-command-condition-program', 'Game_Interpreter.command111: input-key identity or JavaScript condition', 'logic_identity');
    if (!tail.length && command.code === 122 && parameter === 4 && command.parameters[3] === 4) return evidence(parts, 'rpg-command-variable-program', 'Game_Interpreter.command122: JavaScript operand', 'logic_identity');
  }
  // The native runtime parses note keys as metadata. Prose-only notes remain eligible;
  // a whole tagged field cannot be replaced as prose while preserving that contract.
  if (parts.at(-1) === 'note' && /<[^<>:]+(?::[^<>]*)?>/.test(at(document, parts))) {
    const owner = at(document, parts.slice(0, -1));
    if (record(owner) && (profile === 'map' && parts.length === 1
        || Number.isInteger(owner.id) && (Array.isArray(owner.pages) || Array.isArray(owner.list)))) {
      return evidence(parts, 'rpg-tagged-note-metadata', 'DataManager.extractMetadata: tag keys and values; isolate proven display values instead of translating the whole note', 'logic_identity');
    }
  }
}

export function assertJsonFieldWritable({ file, document, pointer }) {
  if (typeof pointer !== 'string' || !pointer.startsWith('/') || /~(?![01])/.test(pointer)) return;
  const parts = pointer.slice(1).split('/').map(part => part.replaceAll('~1', '/').replaceAll('~0', '~'));
  const identity = jsonFieldIdentity(file, document, parts);
  if (identity) throw Object.assign(new Error(`该字段是引擎资源或逻辑身份，不能作为整段译文回写：${file}${pointer}；${identity.consumer}`), {
    code: 'PROTECTED_JSON_IDENTITY', evidence: { file, ...identity },
  });
}
