import fs from 'node:fs/promises';
import path from 'node:path';
import { readConfig, planTechnicalRun } from '../tests/evals/technical/io.mjs';
import { readCredential, runTechnicalService } from '../tests/evals/technical/run-service.mjs';
import { gradeTechnicalRun } from '../tests/evals/technical/grade.mjs';
import { compareTechnicalRuns } from '../tests/evals/technical/compare.mjs';

const [command, ...args] = process.argv.slice(2);
const option = name => args.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const episode = file => path.extname(file) ? file : path.join(file, 'episode.json');
const required = name => { const value = option(name); if (!value) throw new Error(`--${name}=... is required.`); return value; };
const output = async value => {
  const text = JSON.stringify(value, null, 2);
  if (option('output')) await fs.writeFile(path.resolve(option('output')), `${text}\n`);
  process.stdout.write(`${text}\n`);
};

try {
  const allowed = new Set(['config', 'resume', 'episode', 'expectations', 'output', 'before', 'after']);
  for (const argument of args) if (!argument.startsWith('--') || !argument.includes('=') || !allowed.has(argument.slice(2).split('=')[0])) throw new Error('Unknown or malformed evaluation option.');
  if (!command || ['help', '--help'].includes(command)) {
    process.stdout.write('Technical Agent evaluation. No fake model fallback.\n'
      + 'plan --config=explicit-config.json                  No API or project writes.\n'
      + 'run --config=explicit-config.json [--resume=episode-directory]\n'
      + '    Credential: one private stdin JSON line {"apiKey":"..."}; never a CLI option.\n'
      + 'grade --episode=episode-directory [--expectations=answers.json] [--output=grade.json]\n'
      + 'compare --before=episode-directory --after=episode-directory [--expectations=answers.json]\n'
      + 'All runs are unisolated-development. Grade answers are read only after model execution.\n');
  } else if (command === 'plan') {
    await output(await planTechnicalRun(await readConfig(required('config'))));
  } else if (command === 'run') {
    if (option('expectations') || option('api-key')) throw new Error('Run accepts neither grading answers nor a command-line credential.');
    const config = await readConfig(required('config'));
    const apiKey = await readCredential();
    const { episodeDir, report } = await runTechnicalService(config, { apiKey, resume: option('resume') });
    const grade = gradeTechnicalRun(report);
    await output({ episodeDir, outcome: report.outcome, grade, error: report.error, collectionError: report.collectionError });
    if (report.outcome === 'runner-or-product-error' || !grade.eligible) process.exitCode = 1;
  } else if (command === 'grade') {
    const evidence = await readJson(episode(required('episode')));
    const expectations = option('expectations') ? await readJson(option('expectations')) : undefined;
    const grade = gradeTechnicalRun(evidence, { expectations }); await output(grade);
    if (grade.autonomyStatus !== 'passed') process.exitCode = 2;
  } else if (command === 'compare') {
    const before = await readJson(episode(required('before'))), after = await readJson(episode(required('after')));
    const expectations = option('expectations') ? await readJson(option('expectations')) : undefined;
    const comparison = compareTechnicalRuns(before, after, { expectations }); await output(comparison);
    if (!comparison.comparable) process.exitCode = 1;
  } else throw new Error(`Unknown evaluation command: ${command}`);
} catch (error) {
  process.stderr.write(`${error.message}\n`); process.exitCode = 1;
}
