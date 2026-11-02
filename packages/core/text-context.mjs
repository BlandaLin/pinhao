import { compactStoryContext } from '../exchange/story.mjs';

const contextFields = new Set(['file', 'field', 'record', 'recordId', 'map', 'mapId', 'mapName', 'event', 'eventId', 'eventName', 'page', 'scene', 'sceneId', 'blockId', 'storyBlockRef', 'storyLinksHash', 'characterId', 'characterIds',
  'speaker', 'speakerId', 'actorId', 'speakerBasis', 'speakerState', 'semanticScope', 'branch', 'branch_path', 'branchPath', 'choice', 'choices', 'condition',
  'command', 'code', 'indent', 'line_count', 'face', 'name', 'label', 'title', 'summary', 'description', 'meaning', 'constraints', 'syncGroup', 'scope',
  'evidence', 'evidenceIds', 'references', 'reading', 'story', 'links', 'storyLinks', 'previousTranslations', 'speaker_basis', 'speaker_state', 'actor_id', 'actor_attribute',
  'common_event', 'troop', 'map_id', 'event_id', 'page_index', 'scene_id', 'block_id', 'character_id']);
const detailFields = new Set([...contextFields, 'id', 'unitId', 'unitIds', 'kind', 'source', 'currentTranslation', 'translation', 'translationState', 'notes',
  'type', 'target', 'targetId', 'targetIds', 'state', 'basis', 'reason', 'text', 'value', 'then', 'else', 'index', 'offset', 'limit', 'total', 'path', 'revision',
  'context', 'controls', 'category', 'side', 'operator', 'left', 'right', 'coordinates', 'gender', 'pronoun', 'formality', 'pointOfView', 'tense', 'tone', 'relationship', 'role', 'identity']);
function projectFields(value, fields) {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
  if (Array.isArray(value)) return value.map(item => projectFields(item, detailFields));
  if (!value || typeof value !== 'object') return undefined;
  return Object.fromEntries(Object.entries(value).filter(([key]) => fields.has(key)).map(([key, item]) => [key, key === 'controls' && item && typeof item === 'object'
    ? Object.fromEntries(Object.entries(item).filter(([, meaning]) => typeof meaning === 'string')) : projectFields(item, detailFields)]).filter(([, item]) => item !== undefined));
}
// Kept byte-for-byte in meaning for paid receipts written before language projection.
export const legacyPromptContext = context => context ? projectFields(compactStoryContext(context), contextFields) : context;

const sections = new Set(['evidence', 'reading', 'references']);
const locations = new Set(['path', 'file', 'field', 'index', 'offset', 'revision', 'recordId', 'command', 'code', 'indent', 'line_count']);
const locationLabels = new Set(['kind', 'type', 'id', 'scene', 'sceneId', 'blockId', 'storyBlockRef', 'storyLinksHash', 'description', 'context']);
const semanticKinds = new Set(['character', 'person', 'speaker', 'actor', 'relationship', 'relation', 'scene', 'story', 'branch', 'condition', 'meaning', 'dialogue', 'conversation']);
const semanticValues = new Set(['condition', 'branch', 'branch_path', 'branchPath', 'choice', 'choices', 'constraints', 'meaning',
  'controls', 'speakerBasis', 'speakerState', 'speaker_basis', 'speaker_state', 'semanticScope', 'scope', 'relationship', 'then', 'else']);
const present = value => value !== undefined && value !== null && value !== ''
  && (!Array.isArray(value) || value.length > 0) && (typeof value !== 'object' || Object.keys(value).length > 0);
const unique = rows => [...new Map(rows.map(row => [JSON.stringify(row), row])).values()];

function languageEvidence(value) {
  if (Array.isArray(value)) return unique(value.map(languageEvidence).filter(present));
  if (!value || typeof value !== 'object') return value;
  const located = [...locations].some(key => Object.hasOwn(value, key));
  const semanticRecord = semanticKinds.has(value.kind) || semanticKinds.has(value.type) || Object.hasOwn(value, 'id') && present(value.description);
  const locatorRecord = located && !semanticRecord && ['index', 'field', 'recordId', 'command', 'offset'].some(key => Object.hasOwn(value, key));
  const row = {};
  for (const [key, item] of Object.entries(value)) {
    if (locations.has(key)) continue;
    // A locator's kind/description explain extraction, not the line's meaning.
    if (locatorRecord && locationLabels.has(key) && key !== 'context') continue;
    // Expressions and control dictionaries have their own keys (including index/field).
    const projected = semanticValues.has(key) ? item : languageEvidence(item);
    if (present(projected)) row[key] = projected;
  }
  // Descriptions accompanying actual language evidence may explain that evidence.
  if (Object.keys(row).length && present(value.description)) row.description = value.description;
  if (!Object.keys(row).length) return undefined;
  // Preserve scope identity when an occurrence carries an actual condition or speaker.
  if (located) for (const key of ['scene', 'sceneId', 'blockId']) if (present(value[key])) row[key] = value[key];
  return row;
}

/** Language facts travel inline; complete engineering records stay addressable on their owner. */
export function languageContext(context, { unitId, detail = false } = {}) {
  const projected = legacyPromptContext(context);
  if (detail || !projected || typeof projected !== 'object' || Array.isArray(projected)) return projected;
  const result = { ...projected }, access = [];
  for (const field of ['speaker_key', 'speaker_name']) {
    if (typeof context[field] === 'string' && context[field]) result[field] = context[field];
  }
  for (const section of sections) {
    if (!Object.hasOwn(context, section)) continue;
    const value = languageEvidence(projected[section]);
    if (present(value)) result[section] = value;
    else delete result[section];
    if (unitId && JSON.stringify(value) !== JSON.stringify(context[section])) access.push({ section,
      total: Array.isArray(context[section]) ? context[section].length : 1,
      query: { evidence: { unitId, section }, offset: 0, limit: 16 } });
  }
  if (access.length) result.evidenceAccess = access;
  return result;
}
