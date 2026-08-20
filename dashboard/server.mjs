import express from 'express';
import dotenv from 'dotenv';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Dashboard API — a thin driver around the Playwright CLI.
 *
 * Two jobs: list the scenarios, and run exactly one of them.
 *
 * Runs are SERIALISED. These tests drive GSC's live production booking system,
 * and one of them holds real seat inventory, so the server refuses to start a
 * second run while one is in flight rather than letting a dashboard user fan
 * out concurrent traffic with a few impatient clicks.
 */

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The same .env the Playwright config reads, so the dashboard can tell the user
// whether the sign-in scenarios will actually run or quietly skip.
dotenv.config({ path: path.join(projectRoot, '.env'), quiet: true });
const PORT = Number(process.env.DASHBOARD_PORT ?? 8787);
const PROJECT = 'chromium';

const app = express();
app.use(express.json());

/** Playwright is launched via the local CLI; npx resolution differs on Windows. */
const PLAYWRIGHT_BIN = path.join(
  projectRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'playwright.cmd' : 'playwright',
);

function runPlaywright(args) {
  return new Promise((resolve) => {
    const child = spawn(PLAYWRIGHT_BIN, args, {
      cwd: projectRoot,
      shell: process.platform === 'win32',
      env: { ...process.env, FORCE_COLOR: '0' },
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.on('error', (error) => resolve({ code: -1, stdout, stderr: String(error) }));
  });
}

/**
 * The JSON reporter prints one object to stdout, but anything the test or a
 * plugin logs lands there too. Take the outermost JSON object rather than
 * trusting the whole stream to parse.
 */
function parseReport(stdout) {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(stdout.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** Walk the reporter's nested suites and flatten every spec out of them. */
function collectSpecs(report) {
  const specs = [];

  const walk = (suite, file) => {
    const specFile = suite.file ?? file;
    for (const spec of suite.specs ?? []) specs.push({ ...spec, file: spec.file ?? specFile });
    for (const child of suite.suites ?? []) walk(child, specFile);
  };

  for (const suite of report.suites ?? []) walk(suite, suite.file);
  return specs;
}

/**
 * Group label from the spec file: "e2e/01-browse-and-select.spec.ts" becomes
 * step 01, "Browse and select". Derived rather than hardcoded so new spec files
 * appear on the dashboard without touching this server.
 */
function describeFile(file) {
  const base = file.split('/').pop() ?? file;
  const match = base.match(/^(\d+)-(.+)\.spec\.ts$/);

  if (!match) {
    const name = base.replace(/\.spec\.ts$/, '').replace(/[-_]/g, ' ');
    return { step: null, label: name.charAt(0).toUpperCase() + name.slice(1) };
  }

  const words = match[2].replace(/-/g, ' ');
  return { step: match[1], label: words.charAt(0).toUpperCase() + words.slice(1) };
}

/** Tags live in the test title, e.g. "…@smoke @auth". */
function extractTags(title) {
  return [...title.matchAll(/@[\w-]+/g)].map((match) => match[0]);
}

function cleanTitle(title) {
  return title.replace(/@[\w-]+/g, '').replace(/\s+/g, ' ').trim();
}

let scenarioCache = { at: 0, data: null };

async function loadScenarios() {
  if (scenarioCache.data && Date.now() - scenarioCache.at < 15_000) return scenarioCache.data;

  const { stdout, stderr, code } = await runPlaywright(['test', '--list', '--reporter=json']);
  const report = parseReport(stdout);

  if (!report) {
    throw new Error(`Could not read the test list (exit ${code}). ${stderr.slice(0, 400)}`);
  }

  const byId = new Map();

  for (const spec of collectSpecs(report)) {
    // The same spec appears once per project; the dashboard runs chromium only,
    // so collapse them and keep the file:line identity.
    const id = `${spec.file}:${spec.line}`;
    if (byId.has(id)) continue;

    const tags = extractTags(spec.title);
    byId.set(id, {
      id,
      file: spec.file,
      line: spec.line,
      title: cleanTitle(spec.title),
      tags,
      requiresAuth: tags.includes('@auth'),
      holdsInventory: tags.includes('@inventory'),
    });
  }

  const groups = new Map();
  for (const scenario of byId.values()) {
    const { step, label } = describeFile(scenario.file);
    const key = scenario.file;
    if (!groups.has(key)) groups.set(key, { file: key, step, label, scenarios: [] });
    groups.get(key).scenarios.push(scenario);
  }

  const data = [...groups.values()].sort((a, b) => {
    if (a.step && b.step) return a.step.localeCompare(b.step);
    if (a.step) return 1; // unnumbered files (the harness smoke) sort first
    if (b.step) return -1;
    return a.label.localeCompare(b.label);
  });

  scenarioCache = { at: Date.now(), data };
  return data;
}

app.get('/api/scenarios', async (_request, response) => {
  try {
    const groups = await loadScenarios();
    response.json({
      groups,
      credentialsConfigured: Boolean(process.env.GSC_MOBILE && process.env.GSC_PASSWORD),
    });
  } catch (error) {
    response.status(500).json({ error: String(error.message ?? error) });
  }
});

let running = null;

app.get('/api/status', (_request, response) => {
  response.json({ running });
});

app.post('/api/run', async (request, response) => {
  const { id } = request.body ?? {};

  if (running) {
    return response.status(409).json({
      error: `A run is already in progress: ${running}. These tests hit live production, so they run one at a time.`,
    });
  }

  // Only ids the CLI itself reported are runnable — never pass user input
  // straight through to a spawned process.
  const groups = await loadScenarios().catch(() => []);
  const known = groups.flatMap((group) => group.scenarios).find((scenario) => scenario.id === id);

  if (!known) return response.status(404).json({ error: `Unknown scenario: ${id}` });

  running = id;
  const startedAt = Date.now();

  try {
    const target = `${path.posix.join('tests', known.file)}:${known.line}`;
    const { stdout, stderr } = await runPlaywright([
      'test',
      target,
      `--project=${PROJECT}`,
      '--reporter=json',
      '--retries=0',
    ]);

    const report = parseReport(stdout);
    const result = report ? collectSpecs(report)[0]?.tests?.[0]?.results?.[0] : null;

    // Playwright reports a skip as its own status; surface it as such rather
    // than calling it a pass, because a skipped auth test proves nothing.
    const status = result?.status ?? (report ? 'unknown' : 'errored');
    const errors = (result?.errors ?? [])
      .map((error) => (error.message ?? '').replace(/\[\d+m/g, '').trim())
      .filter(Boolean);

    response.json({
      id,
      status,
      durationMs: result?.duration ?? Date.now() - startedAt,
      errors,
      annotations: (result?.annotations ?? report?.suites?.[0]?.specs?.[0]?.tests?.[0]?.annotations ?? [])
        .map((annotation) => annotation.description)
        .filter(Boolean),
      stderr: stderr.slice(0, 600),
      finishedAt: new Date().toISOString(),
    });
  } catch (error) {
    response.status(500).json({ id, status: 'errored', errors: [String(error.message ?? error)] });
  } finally {
    running = null;
  }
});

app.listen(PORT, () => {
  console.log(`QA dashboard API listening on http://localhost:${PORT}`);
});
