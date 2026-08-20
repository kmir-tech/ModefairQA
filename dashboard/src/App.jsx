import { useCallback, useEffect, useState } from 'react';

const STATUS_LABEL = {
  passed: 'Passed',
  failed: 'Failed',
  timedOut: 'Timed out',
  skipped: 'Skipped',
  interrupted: 'Interrupted',
  errored: 'Could not run',
  unknown: 'No result',
};

function formatDuration(ms) {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Marquee bulbs across the top. They chase only while a scenario is running. */
function Marquee({ live }) {
  return (
    <div className={`marquee ${live ? 'is-live' : ''}`} aria-hidden="true">
      {Array.from({ length: 48 }, (_, index) => (
        <span className="bulb" key={index} style={{ '--i': index }} />
      ))}
    </div>
  );
}

function StatusLamp({ status, running }) {
  const state = running ? 'running' : (status ?? 'idle');
  return <span className={`lamp lamp--${state}`} aria-hidden="true" />;
}

function Scenario({ scenario, result, running, blocked, onRun }) {
  const label = running ? 'Running' : 'Run';

  return (
    <li className={`scenario ${running ? 'is-running' : ''}`}>
      <StatusLamp status={result?.status} running={running} />

      <div className="scenario__body">
        <p className="scenario__title">{scenario.title}</p>

        <div className="scenario__meta">
          <code className="scenario__ref">
            {scenario.file}:{scenario.line}
          </code>

          {scenario.tags
            .filter((tag) => tag !== '@auth' && tag !== '@inventory')
            .map((tag) => (
              <span className="tag" key={tag}>
                {tag}
              </span>
            ))}

          {scenario.requiresAuth && <span className="tag tag--auth">signs in</span>}
          {scenario.holdsInventory && <span className="tag tag--warn">holds a seat</span>}
        </div>

        {result && (
          <div className="result" role="status">
            <span className={`result__status result__status--${result.status}`}>
              {STATUS_LABEL[result.status] ?? result.status}
            </span>
            <span className="result__time">{formatDuration(result.durationMs)}</span>

            {result.annotations?.length > 0 && (
              <span className="result__note">{result.annotations[0]}</span>
            )}

            {result.errors?.length > 0 && <pre className="result__error">{result.errors[0]}</pre>}
          </div>
        )}
      </div>

      <button
        type="button"
        className="run"
        onClick={() => onRun(scenario.id)}
        disabled={running || blocked}
        title={blocked ? 'Another scenario is running. They run one at a time.' : undefined}
      >
        {label}
      </button>
    </li>
  );
}

export default function App() {
  const [groups, setGroups] = useState([]);
  const [credentialsConfigured, setCredentialsConfigured] = useState(true);
  const [results, setResults] = useState({});
  const [runningId, setRunningId] = useState(null);
  const [loadError, setLoadError] = useState(null);

  useEffect(() => {
    fetch('/api/scenarios')
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error('Request failed'))))
      .then((data) => {
        setGroups(data.groups);
        setCredentialsConfigured(data.credentialsConfigured);
      })
      .catch(() => setLoadError('Could not reach the test runner. Start it with npm run dashboard.'));
  }, []);

  const runScenario = useCallback(async (id) => {
    setRunningId(id);
    setResults((current) => ({ ...current, [id]: undefined }));

    try {
      const response = await fetch('/api/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      const data = await response.json();

      setResults((current) => ({
        ...current,
        [id]: response.ok ? data : { status: 'errored', errors: [data.error] },
      }));
    } catch (error) {
      setResults((current) => ({
        ...current,
        [id]: { status: 'errored', errors: [String(error.message ?? error)] },
      }));
    } finally {
      setRunningId(null);
    }
  }, []);

  const scenarios = groups.flatMap((group) => group.scenarios);
  const tally = scenarios.reduce(
    (counts, scenario) => {
      const status = results[scenario.id]?.status;
      if (status === 'passed') counts.passed += 1;
      else if (status === 'failed' || status === 'timedOut' || status === 'errored') counts.failed += 1;
      else if (status === 'skipped') counts.skipped += 1;
      return counts;
    },
    { passed: 0, failed: 0, skipped: 0 },
  );

  return (
    <div className="board">
      <header className="header">
        <Marquee live={Boolean(runningId)} />

        <div className="header__row">
          <div>
            <p className="header__eyebrow">Golden Screen Cinemas · end-to-end suite</p>
            <h1 className="header__title">Test Board</h1>
          </div>

          <dl className="tally">
            <div className="tally__item">
              <dt>Scenarios</dt>
              <dd>{scenarios.length}</dd>
            </div>
            <div className="tally__item tally__item--pass">
              <dt>Passed</dt>
              <dd>{tally.passed}</dd>
            </div>
            <div className="tally__item tally__item--fail">
              <dt>Failed</dt>
              <dd>{tally.failed}</dd>
            </div>
            <div className="tally__item tally__item--skip">
              <dt>Skipped</dt>
              <dd>{tally.skipped}</dd>
            </div>
          </dl>
        </div>
      </header>

      <main className="main">
        <p className="notice notice--live">
          These scenarios run against <strong>gsc.com.my in production</strong>. They run one at a
          time. Nothing in the suite completes a payment.
        </p>

        {!credentialsConfigured && (
          <p className="notice">
            No member credentials found. Scenarios marked <em>signs in</em> will skip. Add
            GSC_MOBILE and GSC_PASSWORD to <code>.env</code> to run them.
          </p>
        )}

        {loadError && <p className="notice notice--error">{loadError}</p>}

        {groups.map((group) => (
          <section className="group" key={group.file}>
            <h2 className="group__heading">
              {group.step && <span className="group__step">{group.step}</span>}
              <span className="group__label">{group.label}</span>
              <span className="group__count">{group.scenarios.length}</span>
            </h2>

            <ul className="scenarios">
              {group.scenarios.map((scenario) => (
                <Scenario
                  key={scenario.id}
                  scenario={scenario}
                  result={results[scenario.id]}
                  running={runningId === scenario.id}
                  blocked={Boolean(runningId) && runningId !== scenario.id}
                  onRun={runScenario}
                />
              ))}
            </ul>
          </section>
        ))}

        {groups.length === 0 && !loadError && <p className="notice">Loading scenarios…</p>}
      </main>
    </div>
  );
}
