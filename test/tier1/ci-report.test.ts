/**
 * Tier 1 tests: scripts/ci-report.sh
 *
 * The report builder is a bash script. Tests invoke it as a subprocess via
 * execFileSync and verify properties of its stdout output (or output file).
 *
 * This file also defines fast-check generators (arbitraryJunitXml,
 * arbitraryTypecheckOutput, arbitraryRunLink) for future property-based tests
 * (Tasks 4.2–4.9 in the structured-ci-feedback spec). The generators are
 * exported for reuse; only example-based unit tests run here today.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import fc from 'fast-check';

const SCRIPT_PATH = resolve(process.cwd(), 'scripts/ci-report.sh');

interface RunReportOpts {
  junitContent?: string;
  typecheckContent?: string;
  junitPath?: string | null; // explicit path; if null, omit --junit
  typecheckPath?: string | null;
  runLink?: string;
  typecheckOutcome: 'success' | 'failure';
  testOutcome: 'success' | 'failure';
  useOutputFile?: boolean;
  workDir?: string;
}

interface RunReportResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  outputFileContent?: string;
}

function makeWorkDir(): string {
  return mkdtempSync(join(tmpdir(), 'ci-report-test-'));
}

/**
 * Helper: invoke scripts/ci-report.sh as a subprocess.
 *
 * Writes junit/typecheck content to temp files (if provided), assembles
 * arguments, and returns captured stdout/stderr/exitCode.
 */
function runReport(opts: RunReportOpts): RunReportResult {
  const workDir = opts.workDir ?? makeWorkDir();
  const args: string[] = [SCRIPT_PATH];

  // Handle JUnit file: explicit path overrides content
  if (opts.junitPath === null) {
    // intentionally omit --junit
  } else if (opts.junitPath !== undefined) {
    args.push('--junit', opts.junitPath);
  } else if (opts.junitContent !== undefined) {
    const path = join(workDir, 'test-results.xml');
    writeFileSync(path, opts.junitContent);
    args.push('--junit', path);
  }

  // Handle typecheck file
  if (opts.typecheckPath === null) {
    // intentionally omit --typecheck
  } else if (opts.typecheckPath !== undefined) {
    args.push('--typecheck', opts.typecheckPath);
  } else if (opts.typecheckContent !== undefined) {
    const path = join(workDir, 'typecheck-output.txt');
    writeFileSync(path, opts.typecheckContent);
    args.push('--typecheck', path);
  }

  args.push('--run-link', opts.runLink ?? 'https://github.com/test/test/actions/runs/12345');
  args.push('--typecheck-outcome', opts.typecheckOutcome);
  args.push('--test-outcome', opts.testOutcome);

  let outputFilePath: string | undefined;
  if (opts.useOutputFile) {
    outputFilePath = join(workDir, 'report.md');
    args.push('--output', outputFilePath);
  }

  let stdout = '';
  let stderr = '';
  let exitCode = 0;
  try {
    stdout = execFileSync('bash', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    const e = err as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    exitCode = e.status ?? -1;
    stdout = typeof e.stdout === 'string' ? e.stdout : e.stdout?.toString('utf8') ?? '';
    stderr = typeof e.stderr === 'string' ? e.stderr : e.stderr?.toString('utf8') ?? '';
  }

  const result: RunReportResult = { stdout, stderr, exitCode };
  if (outputFilePath && existsSync(outputFilePath)) {
    result.outputFileContent = readFileSync(outputFilePath, 'utf8');
  }
  return result;
}

// --- fast-check generators (Task 4.1, for future property tests) ---

interface JunitOpts {
  totalTests?: number;
  failureCount?: number;
  traceLength?: number; // approximate chars per trace
}

/**
 * Generate a structurally valid JUnit XML document.
 *
 * Produces a single <testsuites> with one <testsuite> containing `totalTests`
 * testcases, the first `failureCount` of which have <failure> children with
 * traces of roughly `traceLength` characters.
 */
export function arbitraryJunitXml(opts: JunitOpts = {}): fc.Arbitrary<string> {
  const totalTestsArb = opts.totalTests !== undefined ? fc.constant(opts.totalTests) : fc.integer({ min: 1, max: 50 });
  const traceLenArb = opts.traceLength !== undefined ? fc.constant(opts.traceLength) : fc.integer({ min: 50, max: 500 });

  return fc.tuple(totalTestsArb, traceLenArb).chain(([totalTests, traceLen]) => {
    const failureCountArb =
      opts.failureCount !== undefined
        ? fc.constant(Math.min(opts.failureCount, totalTests))
        : fc.integer({ min: 0, max: totalTests });

    return failureCountArb.chain((failureCount) => {
      const nameArb = fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9 ]{2,30}$/);
      const fileArb = fc.stringMatching(/^test\/tier[12]\/[a-z]{3,15}\.test\.ts$/);
      return fc
        .tuple(
          fc.array(nameArb, { minLength: totalTests, maxLength: totalTests }),
          fc.array(fileArb, { minLength: totalTests, maxLength: totalTests }),
          fc.array(fc.stringMatching(/^[A-Za-z0-9 .'-]{5,80}$/), {
            minLength: failureCount,
            maxLength: failureCount,
          }),
        )
        .map(([names, files, messages]) => {
          const trace = 'at frame.ts:1:1\n'.repeat(Math.max(1, Math.floor(traceLen / 20)));
          const cases = names.map((name, i) => {
            const file = files[i] ?? 'test/tier1/unknown.test.ts';
            if (i < failureCount) {
              const msg = messages[i] ?? 'unknown failure';
              return (
                `        <testcase classname="${file}" name="${escapeXml(name)}" time="0.01">\n` +
                `            <failure message="${escapeXml(msg)}" type="AssertionError">\n` +
                `${escapeXml(trace)}` +
                `            </failure>\n` +
                `        </testcase>`
              );
            }
            return `        <testcase classname="${file}" name="${escapeXml(name)}" time="0.01"/>`;
          });

          const firstFile = files[0] ?? 'test/tier1/unknown.test.ts';
          return (
            `<?xml version="1.0" encoding="UTF-8" ?>\n` +
            `<testsuites name="vitest tests" tests="${totalTests}" failures="${failureCount}" errors="0" time="1.0">\n` +
            `    <testsuite name="${firstFile}" tests="${totalTests}" failures="${failureCount}" errors="0" skipped="0" time="1.0">\n` +
            cases.join('\n') +
            `\n    </testsuite>\n` +
            `</testsuites>\n`
          );
        });
    });
  });
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

interface TypecheckOpts {
  errorCount?: number;
}

/**
 * Generate typecheck output: N error lines in `<file>(<line>,<col>): error TS<code>: <msg>` format.
 */
export function arbitraryTypecheckOutput(opts: TypecheckOpts = {}): fc.Arbitrary<string> {
  const countArb = opts.errorCount !== undefined ? fc.constant(opts.errorCount) : fc.integer({ min: 0, max: 30 });
  return countArb.chain((count) =>
    fc
      .array(
        fc.tuple(
          fc.stringMatching(/^src\/[a-z]{3,15}\.ts$/),
          fc.integer({ min: 1, max: 999 }),
          fc.integer({ min: 1, max: 99 }),
          fc.integer({ min: 1000, max: 9999 }),
          fc.stringMatching(/^[A-Za-z '.-]{5,60}$/),
        ),
        { minLength: count, maxLength: count },
      )
      .map((rows) => rows.map(([f, l, c, code, msg]) => `${f}(${l},${c}): error TS${code}: ${msg}.`).join('\n')),
  );
}

/**
 * Generate a plausible GitHub Actions run URL.
 */
export function arbitraryRunLink(): fc.Arbitrary<string> {
  return fc
    .tuple(
      fc.stringMatching(/^[a-z][a-z0-9-]{2,20}$/),
      fc.stringMatching(/^[a-z][a-z0-9-]{2,20}$/),
      fc.integer({ min: 1, max: 99999999 }),
    )
    .map(([org, repo, runId]) => `https://github.com/${org}/${repo}/actions/runs/${runId}`);
}

// --- Unit tests (Task 5.1) ---

describe('ci-report.sh', () => {
  beforeAll(() => {
    if (!existsSync(SCRIPT_PATH)) {
      throw new Error(`ci-report.sh not found at ${SCRIPT_PATH}`);
    }
  });

  describe('success report (Req 4.1, 4.2)', () => {
    it('produces a brief report with status and run link when both checks pass', () => {
      const { stdout, exitCode } = runReport({
        runLink: 'https://github.com/foo/bar/actions/runs/999',
        typecheckOutcome: 'success',
        testOutcome: 'success',
      });

      expect(exitCode).toBe(0);
      expect(stdout).toContain('## CI (test): ✅ All checks passed');
      expect(stdout).toContain('https://github.com/foo/bar/actions/runs/999');
      // No verbose listings (Req 4.2)
      expect(stdout).not.toContain('## Tests');
      expect(stdout).not.toContain('## Typecheck');
      expect(stdout).not.toContain('### Failed Tests');
    });

    it('uses ✅ glyph in success status line', () => {
      const { stdout } = runReport({
        typecheckOutcome: 'success',
        testOutcome: 'success',
      });
      expect(stdout.split('\n')[0]).toMatch(/^## CI \(test\): ✅/);
    });
  });

  describe('missing inputs (Req 1.3, 9.1)', () => {
    it('produces notice when JUnit XML is missing but test outcome is failure', () => {
      const { stdout, exitCode } = runReport({
        junitPath: null,
        typecheckContent: 'src/foo.ts(1,1): error TS2322: Type error.',
        typecheckOutcome: 'failure',
        testOutcome: 'failure',
      });

      expect(exitCode).toBe(0);
      expect(stdout).toMatch(/Test results file not found/);
    });

    it('produces notice when typecheck output is missing but typecheck outcome is failure', () => {
      const failingJunit =
        `<?xml version="1.0"?><testsuites tests="1" failures="1"><testsuite name="t.ts" tests="1" failures="1">` +
        `<testcase classname="t.ts" name="boom"><failure message="x" type="E">trace</failure></testcase>` +
        `</testsuite></testsuites>`;
      const { stdout, exitCode } = runReport({
        junitContent: failingJunit,
        typecheckPath: null,
        typecheckOutcome: 'failure',
        testOutcome: 'failure',
      });

      expect(exitCode).toBe(0);
      expect(stdout).toMatch(/Typecheck output not found/);
    });

    it('produces minimal report when both input files are missing (Req 9.1)', () => {
      const { stdout, exitCode } = runReport({
        junitPath: null,
        typecheckPath: null,
        runLink: 'https://github.com/test/test/actions/runs/777',
        typecheckOutcome: 'failure',
        testOutcome: 'failure',
      });

      expect(exitCode).toBe(0);
      expect(stdout).toContain('## CI (test): ❌ Checks failed');
      expect(stdout).toContain('CI ran but produced no parseable output');
      expect(stdout).toContain('https://github.com/test/test/actions/runs/777');
      // Should not include structured sections in this minimal mode
      expect(stdout).not.toContain('## Tests');
      expect(stdout).not.toContain('## Typecheck');
    });
  });

  describe('malformed XML (Req 9.4)', () => {
    it('falls back gracefully when JUnit XML is malformed', () => {
      const { stdout, exitCode } = runReport({
        junitContent: '<not really xml at all',
        typecheckPath: null,
        typecheckOutcome: 'success',
        testOutcome: 'failure',
      });

      expect(exitCode).toBe(0);
      // Should mention parse failure or fall back to "results file" notice
      expect(stdout).toMatch(/Failed to parse test results|malformed/);
      // Header still present
      expect(stdout).toContain('## CI (test): ❌ Checks failed');
    });

    it('handles empty JUnit XML file', () => {
      const { stdout, exitCode } = runReport({
        junitContent: '',
        typecheckPath: null,
        typecheckOutcome: 'success',
        testOutcome: 'failure',
      });

      expect(exitCode).toBe(0);
      expect(stdout).toMatch(/Test results file empty|Test results file not found/);
    });
  });

  describe('output flag (Req 7.4)', () => {
    it('writes report to --output file when specified', () => {
      const { exitCode, outputFileContent } = runReport({
        useOutputFile: true,
        typecheckOutcome: 'success',
        testOutcome: 'success',
      });

      expect(exitCode).toBe(0);
      expect(outputFileContent).toBeDefined();
      expect(outputFileContent).toContain('## CI (test): ✅ All checks passed');
    });

    it('writes to stdout when --output is omitted', () => {
      const { stdout, outputFileContent } = runReport({
        typecheckOutcome: 'success',
        testOutcome: 'success',
      });
      expect(stdout).toContain('## CI (test): ✅ All checks passed');
      expect(outputFileContent).toBeUndefined();
    });
  });

  describe('file path arguments (Req 7.2)', () => {
    it('accepts --junit and --typecheck as explicit file paths', () => {
      const workDir = makeWorkDir();
      const junit = join(workDir, 'custom-results.xml');
      const tc = join(workDir, 'custom-tc.txt');
      writeFileSync(
        junit,
        `<?xml version="1.0"?><testsuites tests="1" failures="0"><testsuite name="x" tests="1" failures="0"><testcase classname="x" name="ok"/></testsuite></testsuites>`,
      );
      writeFileSync(tc, '');

      const { stdout, exitCode } = runReport({
        junitPath: junit,
        typecheckPath: tc,
        typecheckOutcome: 'success',
        testOutcome: 'success',
      });
      expect(exitCode).toBe(0);
      expect(stdout).toContain('## CI (test): ✅');
    });
  });

  describe('run link presence (Req 7.3)', () => {
    it('includes the run link in success reports', () => {
      const link = 'https://github.com/x/y/actions/runs/111';
      const { stdout } = runReport({ runLink: link, typecheckOutcome: 'success', testOutcome: 'success' });
      expect(stdout).toContain(link);
    });

    it('includes the run link within the first 5 lines of a failure report', () => {
      const link = 'https://github.com/x/y/actions/runs/222';
      const { stdout } = runReport({
        junitPath: null,
        typecheckContent: 'src/a.ts(1,1): error TS2322: bad.',
        runLink: link,
        typecheckOutcome: 'failure',
        testOutcome: 'failure',
      });
      const firstFive = stdout.split('\n').slice(0, 5).join('\n');
      expect(firstFive).toContain(link);
      expect(firstFive).toMatch(/❌/);
    });
  });

  describe('ANSI escape stripping', () => {
    it('strips ANSI color codes from typecheck output before embedding', () => {
      // Red-colored TS error
      const ansi = '[31msrc/foo.ts(1,1): error TS2322: bad.[0m';
      const { stdout, exitCode } = runReport({
        junitPath: null,
        typecheckContent: ansi,
        typecheckOutcome: 'failure',
        testOutcome: 'failure',
      });
      expect(exitCode).toBe(0);
      // The escape character () must not appear in the rendered report
      expect(stdout).not.toContain('[');
      expect(stdout).toContain('src/foo.ts(1,1): error TS2322: bad.');
    });
  });

  describe('feature flag is workflow-level (script is flag-agnostic)', () => {
    it('produces a report regardless of any ENABLE_PR_COMMENTS env var', () => {
      // The script never reads ENABLE_PR_COMMENTS — the gate lives in ci.yml.
      // Setting it to "false" must not affect script output.
      const workDir = makeWorkDir();
      const args = [
        SCRIPT_PATH,
        '--run-link',
        'https://github.com/x/y/actions/runs/333',
        '--typecheck-outcome',
        'success',
        '--test-outcome',
        'success',
      ];
      const stdout = execFileSync('bash', args, {
        encoding: 'utf8',
        env: { ...process.env, ENABLE_PR_COMMENTS: 'false' },
      });
      expect(stdout).toContain('## CI (test): ✅ All checks passed');
      rmSync(workDir, { recursive: true, force: true });
    });
  });

  describe('failure report shape (Req 3.1, 3.4)', () => {
    it('extracts typecheck errors with file path and line numbers', () => {
      const { stdout } = runReport({
        junitPath: null,
        typecheckContent:
          `src/foo.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.\n` +
          `src/bar.ts(45,10): error TS2345: Argument of type X.`,
        typecheckOutcome: 'failure',
        testOutcome: 'failure',
      });
      expect(stdout).toContain('## Typecheck');
      expect(stdout).toContain('src/foo.ts(12,5)');
      expect(stdout).toContain('src/bar.ts(45,10)');
      expect(stdout).toContain('TS2322');
    });

    it('extracts failed test names, files, and error messages into a table', () => {
      const junit =
        `<?xml version="1.0"?><testsuites tests="2" failures="1">` +
        `<testsuite name="test/tier1/parser.test.ts" tests="2" failures="1">` +
        `<testcase classname="test/tier1/parser.test.ts" name="should handle empty input">` +
        `<failure message="Expected '' to equal 'foo'" type="AssertionError">trace line\nat parser.ts:15:20</failure>` +
        `</testcase>` +
        `<testcase classname="test/tier1/parser.test.ts" name="should pass"/>` +
        `</testsuite></testsuites>`;
      const { stdout } = runReport({
        junitContent: junit,
        typecheckPath: null,
        typecheckOutcome: 'success',
        testOutcome: 'failure',
      });
      expect(stdout).toContain('## Tests');
      expect(stdout).toContain('| Test | File | Error |');
      expect(stdout).toContain('should handle empty input');
      expect(stdout).toContain('test/tier1/parser.test.ts');
      expect(stdout).toContain("Expected '' to equal 'foo'");
    });
  });
});
