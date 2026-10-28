// The experimental Windows carrier exposes the same real business modules for
// isolated acceptance without depending on the development checkout.
export { createAdapterLab } from '../packages/technical/adaptation/adapter-lab.mjs';
export { createAdaptationBudget } from '../packages/core/adaptation-budget.mjs';
export { runDshAdaptation, inspectDshRuntime } from '../packages/technical/dsh-runner.mjs';
export { readAdaptationState } from '../packages/technical/adaptation.mjs';
