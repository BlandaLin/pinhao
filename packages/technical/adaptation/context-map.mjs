// This is a display allowance, not a token estimate or a request/retry budget.
export function technicalToolCharacters(connection = {}, capacity = {}) {
  const context = capacity.contextWindow ?? connection.contextWindow ?? 32768;
  const output = capacity.maxOutputTokens ?? connection.maxOutputTokens ?? 4096;
  return Math.max(2000, Math.min(24000, Math.floor((context - output - 4096) / 2)));
}

/** Full evidence is already persisted; keep navigation ahead of potentially huge object metadata. */
export function contextMap(value, evidenceId, maxCharacters) {
  const read = pointer => ({ tool: 'read_evidence', input: { evidenceId, pointer } });
  const { coverage, tools, progress, failure, executionContext, ...rest } = value;
  const result = { projectionVersion: 2, ...(coverage || tools?.trusted?.length ? { outputTruncated: true } : {}),
    tools: tools ? { ...tools, trusted: tools.trusted?.map(item => ({ name: item.name,
    interface: item.interface, argsHint: item.argsHint, argContract: item.argContract })), read: read('/tools') } : tools,
    progress, failure, executionContext, ...rest, fullContext: read(''), coverage: coverage ? {
    summary: coverage.summary, triggers: coverage.triggers, unknownTotal: coverage.unknownTotal,
    candidateInterfaces: coverage.candidateInterfaces, readMore: coverage.readMore,
    read: read('/coverage'),
  } : null };
  if (!coverage) return result;
  const fields = ['unknownClusters', 'resources', 'dynamicCandidates', 'nativeReviewIssues', 'expressionCandidates', 'issues', 'displaySites'];
  const pages = fields.filter(field => Array.isArray(coverage[field])).map(field => {
    const items = coverage[field];
    result.coverage[`${field}PreviewTotal`] = items.length;
    result.coverage[field] = [];
    return { field, items };
  });
  // Round-robin gives each resource category a visible entry instead of letting the first win.
  for (let index = 0; pages.some(page => index < page.items.length); index++) {
    for (const { field, items } of pages) {
      if (index >= items.length) continue;
      const item = items[index];
      const entry = item && typeof item === 'object' ? Object.fromEntries(
        ['id', 'file', 'carrier', 'kind', 'status', 'count', 'evidenceHash', 'sourceIndex', 'diagnosticId', 'scriptIdentity'].filter(key => item[key] !== undefined)
          .map(key => [key, item[key]])) : { summary: String(item).slice(0, 120) };
      entry.read = read(`/coverage/${field}/${index}`);
      result.coverage[field].push(entry);
      if (JSON.stringify(result).length > maxCharacters - 1600) result.coverage[field].pop();
    }
  }
  return result;
}
