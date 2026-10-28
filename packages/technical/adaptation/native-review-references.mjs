const groupPattern = /^native-review-v1:[a-f0-9]{16}:[a-f0-9]{24}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const evidencePattern = /^evidence-[a-f0-9]{64}$/;
export const nativeReviewReferenceSchema = { type: 'string', pattern: '^g[1-9][0-9]*$',
  description: '使用native_review实际返回的groupRef；主机绑定该次已观察资源快照，不填写长编号或哈希。' };
export const nativeDisplayReferenceSchema = { type: 'string', pattern: '^s[1-9][0-9]*$' };
export const nativeReviewReferenceRecovery = '先调用native_review({})查看本资源，使用返回groups[].groupRef；其他资源可显式传file，不填写groupId或evidenceHash。';

/** Model references identify observed snapshots, never a freshly reread replacement hash. */
export function createNativeReviewReferences(state) {
  state.nativeReviewReferences ??= [];
  const records = state.nativeReviewReferences;
  const byRef = new Map(records.map(record => [record.ref, record]));
  const bySnapshot = new Map(records.map(record => [`${record.groupId}\0${record.evidenceHash}`, record]));
  const fail = (message, issues) => Object.assign(new Error(message), { code: 'NATIVE_REVIEW_PROTOCOL', nextAction: nativeReviewReferenceRecovery,
    ...(issues ? { evidence: { issues } } : {}) });
  const lookup = (ref, path = 'groupRef') => {
    const record = byRef.get(ref);
    if (!record || !groupPattern.test(record.groupId) || !hashPattern.test(record.evidenceHash) || !evidencePattern.test(record.evidenceId)) {
      throw fail(`未观察或不可恢复的原生组引用${JSON.stringify(ref)}；需要先读取实际资源。`,
        [{ path, received: ref ?? null, problem: '使用native_review实际返回的groupRef' }]);
    }
    return record;
  };
  const observed = (groupId, evidenceHash) => evidenceHash === undefined
    ? records.findLast(record => record.groupId === groupId) : bySnapshot.get(`${groupId}\0${evidenceHash}`);
  const observe = (output, receipt = output) => {
    if (output?.schema !== 'pinhao-native-field-review-v1' || !evidencePattern.test(receipt?.evidenceId)) return;
    for (const [index, group] of (output.groups ?? []).entries()) {
      if (!groupPattern.test(group?.groupId) || !hashPattern.test(group?.evidenceHash)) continue;
      const key = `${group.groupId}\0${group.evidenceHash}`;
      if (bySnapshot.has(key)) continue;
      const ref = `g${records.length + 1}`;
      const sites = [];
      for (const field of group.fieldUses?.fields ?? []) for (const use of field.uses ?? []) {
        if (!/^display-site-v1:[a-f0-9]{64}$/.test(use.siteId ?? '')) continue;
        if (!sites.some(site => site.siteId === use.siteId && JSON.stringify(site.path) === JSON.stringify(field.path))) {
          sites.push({ ref: `s${sites.length + 1}`, siteId: use.siteId, path: structuredClone(field.path) });
        }
      }
      const record = { ref, groupId: group.groupId, evidenceHash: group.evidenceHash, file: group.file,
        evidenceId: receipt.evidenceId, pointer: `/groups/${index}`, sites };
      records.push(record); byRef.set(ref, record); bySnapshot.set(key, record);
    }
  };
  const groupView = group => {
    const record = observed(group?.groupId, group?.evidenceHash);
    if (!record) return group;
    const { groupId, evidenceHash, ...rest } = group;
    if (rest.id === groupId) delete rest.id;
    if (rest.fieldUses) {
      const { assemblySha256, ...fieldUses } = rest.fieldUses;
      rest.fieldUses = { ...fieldUses,
        ...(assemblySha256 ? { assemblyHashEvidence: { evidenceId: record.evidenceId, pointer: `${record.pointer}/fieldUses/assemblySha256` } } : {}),
        ...(Array.isArray(fieldUses.fields) ? { fields: fieldUses.fields.map((field, fieldIndex) => ({ ...field,
          uses: (field.uses ?? []).map((use, useIndex) => {
            const site = record.sites?.find(site => site.siteId === use.siteId && JSON.stringify(site.path) === JSON.stringify(field.path));
            if (!site) return use;
            const { siteId, calls, readUses, ...details } = use;
            return { siteRef: site.ref, ...details,
              ...(calls?.length || readUses?.length ? { consumerEvidence: { evidenceId: record.evidenceId,
                pointer: `${record.pointer}/fieldUses/fields/${fieldIndex}/uses/${useIndex}`,
                callCount: calls?.length ?? 0, readCount: readUses?.length ?? 0,
                ...(calls?.length ? { callsPointer: `${record.pointer}/fieldUses/fields/${fieldIndex}/uses/${useIndex}/calls` } : {}),
                ...(readUses?.length ? { readsPointer: `${record.pointer}/fieldUses/fields/${fieldIndex}/uses/${useIndex}/readUses` } : {}) } } : {}) };
          }) })) } : {}) };
    }
    return { groupRef: record.ref, ...rest };
  };
  const view = output => output && typeof output === 'object' && !Array.isArray(output) ? { ...output,
    ...(Array.isArray(output.groups) && output.schema === 'pinhao-native-field-review-v1' ? { groups: output.groups.map(groupView) } : {}),
    ...(Array.isArray(output.nativeReviews) ? { nativeReviews: output.nativeReviews.map(groupView) } : {}) } : output;
  const decisions = values => {
    if (!Array.isArray(values) || !values.length) throw fail('decisions需要包含实际groupRef的非空结构化数组。');
    return values.map((value, index) => {
      if (value?.groupId !== undefined || value?.evidenceHash !== undefined) throw fail('原生决定只填写groupRef，资源编号与快照哈希由主机保管。');
      const record = lookup(value?.groupRef, `decisions[${index}].groupRef`), { groupRef, ...rest } = value;
      return { groupId: record.groupId, evidenceHash: record.evidenceHash, ...rest,
        ...(Array.isArray(rest.fields) ? { fields: rest.fields.map((field, fieldIndex) => ({ ...field,
          ...(Array.isArray(field.displaySites) ? { displaySites: field.displaySites.map(ref => {
            const site = record.sites?.find(site => site.ref === ref && JSON.stringify(site.path) === JSON.stringify(field.path));
            if (!site) throw fail(`显示消费点${JSON.stringify(ref)}不属于该次观察的当前字段。`,
              [{ path: `decisions[${index}].fields[${fieldIndex}].displaySites`, received: ref, problem: '选择同一groupRef与字段path下实际返回的siteRef' }]);
            return site.siteId;
          }) } : {}) })) } : {}) };
    });
  };
  const read = input => {
    if (input?.groupId !== undefined || input?.evidenceHash !== undefined) throw fail('原生查看只填写groupRef，不填写长编号或哈希。');
    if (input.groupRef === undefined) return { ...input };
    const record = lookup(input.groupRef), { groupRef, ...rest } = input;
    return { ...rest, groupId: record.groupId, file: input.file ?? record.file };
  };
  // Historical raw protocol is projected only for the next model request; local artifacts stay intact.
  const historicalInput = (name, input) => {
    if (name === 'native_review' && input?.groupId !== undefined) {
      const { groupId, ...rest } = input;
      return { ...rest, groupRef: observed(groupId)?.ref ?? 'read-required' };
    }
    if (name === 'native_review_decide' && Array.isArray(input?.decisions)) return { ...input, decisions: input.decisions.map(value => {
      if (value.groupId === undefined) return value;
      const { groupId, evidenceHash, ...rest } = value;
      const record = observed(groupId, evidenceHash);
      return { groupRef: record?.ref ?? 'read-required', ...rest,
        ...(Array.isArray(rest.fields) ? { fields: rest.fields.map(field => ({ ...field,
          ...(Array.isArray(field.displaySites) ? { displaySites: field.displaySites.map(siteId =>
            record?.sites?.find(site => site.siteId === siteId && JSON.stringify(site.path) === JSON.stringify(field.path))?.ref ?? 'read-required') } : {}) })) } : {}) };
    }) };
    return input;
  };
  return { observe, view, decisions, read, historicalInput };
}
