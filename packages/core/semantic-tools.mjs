import { createReadReceipt, createQueryReceipt } from './semantic-state.mjs';
import { readStoryContext, readStoryRelationships } from '../exchange/story.mjs';
import { sha256 } from '../exchange/index.mjs';

const fail = message => { const error = new Error(message); error.code = 'INVALID_EVIDENCE_REQUEST'; throw error; };

/** Read only indexed project text; queries expose no filesystem or execution capability. */
export function resolveEvidenceRequests(requests, units, { maxQueries = 2, maxResults = 32, maxCharacters = 10000, story } = {}) {
  if (!Array.isArray(requests) || !requests.length || requests.length > maxQueries) fail('每轮请提供一到两项文字证据查询。');
  const answers = [], selected = new Map(), receipts = [], storyReceipts = [];
  let characters = 0;
  for (const request of requests) {
    const query = request?.query;
    if (query?.story) {
      if (!story || !['scene', 'character'].includes(query.story.kind) || typeof query.story.id !== 'string') fail('场景或人物材料需要有效的阅读入口');
      if (query.story.mode !== undefined && query.story.mode !== 'relationships') fail('关联材料使用 relationships 阅读模式');
      const relationshipsOnly = query.story.mode === 'relationships';
      const offset = query.offset ?? 0, limit = query.limit ?? 16;
      const relationshipPage = readStoryRelationships(story, query.story, {
        offset: relationshipsOnly ? offset : 0, limit: relationshipsOnly ? limit : 32 });
      const nextRelationshipOffset = relationshipsOnly || offset === 0
        ? (relationshipPage.hasMore ? relationshipPage.nextOffset : null) : (relationshipPage.total ? 0 : null);
      const relationSummary = { scopeVersion: relationshipPage.scopeVersion, relationshipTotal: relationshipPage.total,
        nextRelationshipOffset, relationshipQuery: nextRelationshipOffset === null ? null
          : { story: { kind: query.story.kind, id: query.story.id, mode: 'relationships' }, offset: nextRelationshipOffset, limit: 32 } };
      if (relationshipsOnly || offset === 0) {
        relationSummary.relationships = relationshipPage.links; relationSummary.blocks = relationshipPage.blocks;
        const evidenceIds = new Set(relationshipPage.links.flatMap(link => link.evidenceIds));
        for (const unit of units) if (evidenceIds.has(unit.id)) receipts.push(createReadReceipt(unit));
        if (relationshipPage.links.length) {
          const receipt = { scopeId: relationshipPage.scopeId, scopeKind: 'relationships', scopeVersion: relationshipPage.scopeVersion,
            offset: relationshipsOnly ? offset : 0, nextOffset: relationshipPage.nextOffset,
            relationshipIds: relationshipPage.links.map(link => link.id), unitIds: [...evidenceIds] };
          storyReceipts.push({ ...receipt, hash: sha256(receipt) });
        }
      }
      if (relationshipsOnly) {
        answers.push({ query, total: relationshipPage.total, returnedIds: relationshipPage.links.map(link => link.id),
          nextOffset: relationshipPage.hasMore ? relationshipPage.nextOffset : null, ...relationSummary });
        continue;
      }
      const pageOptions = { ...query.story, offset, limit };
      let page = readStoryContext(story, units, pageOptions);
      const pageCost = records => records.reduce((sum, unit) => sum + (selected.has(unit.id) ? 0 : JSON.stringify(unit).length), 0);
      const fits = records => (selected.size + records.filter(unit => !selected.has(unit.id)).length <= maxResults)
        && characters + pageCost(records) <= maxCharacters;
      // Shrink only at whole-unit / linked-display boundaries. A single large semantic unit
      // remains readable; subsequent queries keep their exact cursor for the next request.
      while (!fits(page.records) && pageOptions.limit > 1) {
        pageOptions.limit--;
        page = readStoryContext(story, units, pageOptions);
      }
      if (!fits(page.records) && selected.size) {
        answers.push({ query, total: page.total, returnedIds: [], nextOffset: offset,
          deferred: '下一页材料将从此位置继续读取', ...relationSummary });
        continue;
      }
      characters += pageCost(page.records);
      for (const unit of page.records) { selected.set(unit.id, unit); receipts.push(createReadReceipt(unit, { translation: unit.translation !== unit.source, notes: Boolean(unit.notes) })); }
      storyReceipts.push(page.receipt);
      answers.push({ query, total: page.total, returnedIds: page.records.map(unit => unit.id), nextOffset: page.hasMore ? page.nextOffset : null, ...relationSummary });
      continue;
    }
    if (!query || typeof query !== 'object' || Array.isArray(query) || Object.keys(query).some(key => !['text', 'ids', 'kinds', 'file', 'offset', 'limit'].includes(key))) fail('证据查询支持原文、文字 ID、类型和资源名。');
    for (const key of ['text', 'file']) if (query[key] !== undefined && (typeof query[key] !== 'string' || query[key].length > 2048)) fail('查询原文和资源名需要简短文字。');
    for (const key of ['ids', 'kinds']) if (query[key] !== undefined && (!Array.isArray(query[key]) || query[key].length > 32 || query[key].some(value => typeof value !== 'string'))) fail('查询 ID 和类型需要文字列表。');
    if (!query.text && !query.file && !query.ids?.length && !query.kinds?.length) fail('请提供需要查询的原文、ID、类型或资源名。');
    const offset = query.offset ?? 0, limit = query.limit ?? 16;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 32) fail('证据分页使用非负位置，每页一到三十二项。');
    const spec = Object.fromEntries(['text', 'ids', 'kinds', 'file'].filter(key => query[key] !== undefined).map(key => [key, query[key]]));
    const receipt = createQueryReceipt(units, spec), found = new Set(receipt.results.map(result => result.id));
    const matches = units.filter(unit => found.has(unit.id)), page = [];
    for (const unit of matches.slice(offset, offset + limit)) {
      if (!selected.has(unit.id) && selected.size >= maxResults) break;
      const length = selected.has(unit.id) ? 0 : JSON.stringify(unit).length;
      if (characters + length > maxCharacters && selected.size) break;
      page.push(unit); selected.set(unit.id, unit); characters += length;
      receipts.push(createReadReceipt(unit, { translation: unit.translation !== unit.source, notes: Boolean(unit.notes) }));
    }
    receipts.push(receipt);
    answers.push({ query: { ...spec, offset, limit }, reason: typeof request.reason === 'string' ? request.reason : '',
      total: matches.length, returnedIds: page.map(unit => unit.id), nextOffset: offset + page.length < matches.length ? offset + page.length : null });
  }
  return { answers, units: [...selected.values()], receipts, storyReceipts };
}
