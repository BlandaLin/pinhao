import { isDeepStrictEqual } from 'node:util';

const fileOf = value => typeof value === 'string' ? value.replaceAll('\\', '/').replace(/^\.\//, '').toLowerCase() : '';
const payload = input => ({ units: input.units ?? [], ...(input.coverageDecisions === undefined ? {} : { coverageDecisions: input.coverageDecisions }) });
const locationOf = unit => {
  const locator = unit.locator ?? unit.context?.adaptationLocator;
  if (!locator) return;
  const file = fileOf(locator.file ?? unit.context?.file ?? unit.file);
  if (typeof locator.pointer === 'string') return JSON.stringify([file, 'json', locator.pointer]);
  if (Number.isSafeInteger(locator.byteStart) && Number.isSafeInteger(locator.byteEnd)) return JSON.stringify([file, 'utf8', locator.byteStart, locator.byteEnd]);
};

function compatible(records, index, keyFor) {
  return records.every(record => {
    const key = keyFor(record);
    return !key || !index.has(key) || isDeepStrictEqual(index.get(key), record);
  });
}

function consistent(records, keyFor) {
  const seen = new Map();
  for (const record of records) {
    const key = keyFor(record);
    if (key && seen.has(key) && !isDeepStrictEqual(seen.get(key), record)) return false;
    if (key) seen.set(key, record);
  }
  return true;
}

function merge(group, input) {
  const units = input.units ?? [], decisions = input.coverageDecisions ?? [];
  const files = input.scopeFiles.map(fileOf);
  if (group.jobs.has(input.jobId) || files.some(file => group.files.has(file))
      || group.jobs.size && group.hasDecisions !== (input.coverageDecisions !== undefined)
      || !compatible(units, group.ids, unit => unit.legacyId ?? unit.id)
      || !compatible(units, group.locations, locationOf)
      || !compatible(decisions, group.decisions, decision => decision.id)) return false;
  for (const unit of units) {
    const id = unit.legacyId ?? unit.id, location = locationOf(unit);
    if (!id || !group.ids.has(id)) group.units.push(unit);
    if (id) group.ids.set(id, unit);
    if (location) group.locations.set(location, unit);
  }
  for (const decision of decisions) {
    if (!decision.id || !group.decisions.has(decision.id)) group.coverageDecisions.push(decision);
    if (decision.id) group.decisions.set(decision.id, decision);
  }
  group.jobs.add(input.jobId);
  group.hasDecisions = input.coverageDecisions !== undefined;
  files.forEach(file => group.files.add(file));
  return true;
}

/** Independent same-turn resource checks share one scan; final checks stay fresh. */
export function createCoverageBatcher(scan) {
  let pending = [], scheduled = false;
  const flush = () => {
    const requests = pending; pending = []; scheduled = false;
    const groups = [];
    for (const request of requests) {
      let group = groups.find(group => merge(group, request.input));
      if (!group) {
        group = { units: [], coverageDecisions: [], ids: new Map(), locations: new Map(), decisions: new Map(), files: new Set(), jobs: new Set(), requests: [] };
        merge(group, request.input); groups.push(group);
      }
      group.requests.push(request);
    }
    for (const group of groups) Promise.resolve().then(() => scan(payload({ units: group.units, coverageDecisions: group.hasDecisions ? group.coverageDecisions : undefined })))
      .then(result => group.requests.forEach(request => request.resolve(result)), error => group.requests.forEach(request => request.reject(error)));
  };
  return input => {
    const units = input.units ?? [], decisions = input.coverageDecisions ?? [];
    if (!input.jobId || !Array.isArray(input.scopeFiles) || !input.scopeFiles.length || input.scopeFiles.some(file => !fileOf(file))
        || !consistent(units, unit => unit.legacyId ?? unit.id) || !consistent(units, locationOf)
        || !consistent(decisions, decision => decision.id)) return Promise.resolve().then(() => scan(payload(input)));
    return new Promise((resolve, reject) => {
      pending.push({ input, resolve, reject });
      if (!scheduled) { scheduled = true; setImmediate(flush); }
    });
  };
}
