/** Apply the same linked-field rules to live responses and saved candidates. */
export function reconcileCandidates({ units, allUnits = units, candidates, validate, requireComplete = true }) {
  const errors = [];
  const current = new Map(units.map(unit => [unit.id, unit]));
  for (const [id, record] of candidates) {
    try {
      if (!current.has(id)) { candidates.delete(id); continue; }
      validate(current.get(id), record.translation);
    } catch (error) { candidates.delete(id); errors.push(`${id}：${error.message}`); }
  }
  const groups = new Map();
  for (const unit of allUnits) if (unit.context?.syncGroup) {
    const key = unit.context.syncGroup;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(unit);
  }
  for (const [key, group] of groups) {
    const requested = group.filter(unit => current.has(unit.id));
    if (!requested.length) continue;
    const values = new Set(group.map(unit => candidates.get(unit.id)?.translation ?? (current.has(unit.id) ? undefined : unit.translation)).filter(value => value !== undefined));
    if (values.size > 1 || requireComplete && requested.some(unit => !candidates.has(unit.id))) {
      for (const unit of requested) candidates.delete(unit.id);
      if (values.size > 1) errors.push(`关联显示字段须使用相同译文：${key}`);
    }
  }
  return { errors, accepted: units.filter(unit => candidates.has(unit.id)), remaining: units.filter(unit => !candidates.has(unit.id)) };
}
