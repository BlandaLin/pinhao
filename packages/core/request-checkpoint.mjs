import { termChoiceMatches } from './text-wire.mjs';

/** Keep complete, valid records while isolating ambiguous IDs within one response. */
export function createRecordCheckpoint({ pending, candidates, validate, onChange }) {
  const expected = new Map(pending.map(unit => [unit.id, unit]));
  const seen = new Set();
  let errors = [], returned = 0;
  const append = records => {
    for (const record of records) {
      returned++;
      const id = record?.id;
      if (typeof id !== 'string' || !expected.has(id)) {
        errors.push('模型返回了当前任务之外的 ID');
        continue;
      }
      if (seen.has(id)) {
        candidates.delete(id);
        errors.push(`模型返回重复 ID：${id}`);
        continue;
      }
      seen.add(id);
      try {
        if (Object.keys(record).some(key => !['id', 'translation', 'notes', 'termChoices'].includes(key))) throw new Error('模型返回了未允许修改的字段');
        if (record.notes !== undefined && typeof record.notes !== 'string') throw new Error('模型备注格式错误');
        validate(expected.get(id), record.translation);
        const unit = expected.get(id);
        const choices = Array.isArray(record.termChoices) ? record.termChoices.filter(choice =>
          termChoiceMatches(unit.source, record.translation, choice))
          .map(({ source, translation }) => ({ source, translation })) : [];
        candidates.set(id, { id, translation: record.translation, ...(record.notes !== undefined ? { notes: record.notes } : {}),
          ...(choices.length ? { termChoices: [...new Map(choices.map(choice => [JSON.stringify(choice), choice])).values()] } : {}) });
      } catch (error) { errors.push(`${id}：${error.message}`); }
    }
    errors = errors.slice(-16);
    onChange({ returned, accepted: candidates.size });
  };
  return {
    append,
    finish(records) {
      if (!Array.isArray(records)) throw new Error('模型 records 格式错误');
      // A final response replaces its streamed prefix; prior-attempt candidates stay intact.
      for (const id of expected.keys()) candidates.delete(id);
      seen.clear(); errors = []; returned = 0;
      append(records);
    },
    get errors() { return errors; },
  };
}
