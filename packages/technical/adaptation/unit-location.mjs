const normalized = value => String(value).replace(/^res:\/\//, '').replaceAll('\\', '/').replace(/^\.\//, '');

export function unitFileMatches(unit, file) {
  const wanted = normalized(file);
  return [unit.context?.carrier, unit.locator?.file, unit.context?.adaptationLocator?.file, unit.context?.file, unit.file]
    .some(location => location !== undefined && normalized(location) === wanted);
}
