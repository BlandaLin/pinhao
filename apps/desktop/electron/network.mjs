import { getCACertificates, setDefaultCACertificates } from 'node:tls';

export function configureSystemTrust() {
  const defaults = getCACertificates('default');
  const system = getCACertificates('system');
  // Retain bundled/extra roots and include the trust already configured in Windows.
  setDefaultCACertificates([...defaults, ...system]);
  return { system: system.length, total: getCACertificates('default').length };
}
