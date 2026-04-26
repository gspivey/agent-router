import { describe, it, expect } from 'vitest';
import {
  composeCheckRunPrompt,
  composeReviewCommentPrompt,
  composeCommandTriggerPrompt,
  composeCronTaskPrompt,
} from '../../src/prompt.js';
import type {
  CheckRunPayload,
  ReviewCommentPayload,
  IssueCommentPayload,
} from '../../src/prompt.js';

describe('composeCheckRunPrompt', () => {
  it('includes check run name, repo, PR number, and output summary', () => {
    const payload: CheckRunPayload = {
      check_run: {
        name: 'ci/build',
        conclusion: 'failure',
        output: { summary: 'Build failed: missing dependency' },
        pull_requests: [{ number: 42 }],
      },
      repository: { full_name: 'myorg/myrepo' },
    };
    const result = composeCheckRunPrompt(payload);
    expect(result).toContain('ci/build');
    expect(result).toContain('myorg/myrepo');
    expect(result).toContain('#42');
    expect(result).toContain('Build failed: missing dependency');
    expect(result).toContain('failed');
    expect(result).toContain('conclusion: failure');
  });

  it('produces "passed" for successful check runs', () => {
    const payload: CheckRunPayload = {
      check_run: {
        name: 'ci/build',
        conclusion: 'success',
        output: { summary: 'All checks passed' },
        pull_requests: [{ number: 42 }],
      },
      repository: { full_name: 'myorg/myrepo' },
    };
    const result = composeCheckRunPrompt(payload);
    expect(result).toContain('passed');
    expect(result).toContain('conclusion: success');
  });

  it('handles null output summary gracefully', () => {
    const payload: CheckRunPayload = {
      check_run: {
        name: 'lint',
        conclusion: 'failure',
        output: { summary: null },
        pull_requests: [{ number: 7 }],
      },
      repository: { full_name: 'org/repo' },
    };
    const result = composeCheckRunPrompt(payload);
    expect(result).toContain('lint');
    expect(result).toContain('org/repo');
    expect(result).toContain('#7');
    expect(result).toContain('(no output summary)');
  });

  it('handles empty pull_requests array', () => {
    const payload: CheckRunPayload = {
      check_run: {
        name: 'test-suite',
        conclusion: 'failure',
        output: { summary: 'Tests failed' },
        pull_requests: [],
      },
      repository: { full_name: 'org/repo' },
    };
    const result = composeCheckRunPrompt(payload);
    expect(result).toContain('test-suite');
    expect(result).toContain('unknown');
  });

  it('handles null conclusion', () => {
    const payload: CheckRunPayload = {
      check_run: {
        name: 'pending-check',
        conclusion: null,
        output: { summary: 'Still running' },
        pull_requests: [{ number: 1 }],
      },
      repository: { full_name: 'org/repo' },
    };
    const result = composeCheckRunPrompt(payload);
    expect(result).toContain('conclusion: unknown');
  });
});

describe('composeReviewCommentPrompt', () => {
  it('includes comment body, file path, diff hunk, repo, and PR number', () => {
    const payload: ReviewCommentPayload = {
      comment: {
        body: 'This needs a null check',
        diff_hunk: '@@ -10,3 +10,5 @@\n+const x = foo();',
        path: 'src/handler.ts',
      },
      pull_request: { number: 15 },
      repository: { full_name: 'myorg/myrepo' },
    };
    const result = composeReviewCommentPrompt(payload);
    expect(result).toContain('This needs a null check');
    expect(result).toContain('src/handler.ts');
    expect(result).toContain('@@ -10,3 +10,5 @@');
    expect(result).toContain('myorg/myrepo');
    expect(result).toContain('#15');
  });

  it('handles empty diff hunk', () => {
    const payload: ReviewCommentPayload = {
      comment: {
        body: 'Looks good',
        diff_hunk: '',
        path: 'README.md',
      },
      pull_request: { number: 1 },
      repository: { full_name: 'a/b' },
    };
    const result = composeReviewCommentPrompt(payload);
    expect(result).toContain('Looks good');
    expect(result).toContain('README.md');
    expect(result).toContain('a/b');
    expect(result).toContain('#1');
  });
});

describe('composeCommandTriggerPrompt', () => {
  it('strips /agent prefix followed by space', () => {
    const payload: IssueCommentPayload = {
      comment: { body: '/agent fix the tests' },
      issue: { number: 99 },
      repository: { full_name: 'myorg/myrepo' },
    };
    const result = composeCommandTriggerPrompt(payload);
    expect(result).toContain('fix the tests');
    expect(result).not.toContain('/agent');
    expect(result).toContain('myorg/myrepo');
    expect(result).toContain('#99');
  });

  it('strips /agent when it is the entire body (end-of-string)', () => {
    const payload: IssueCommentPayload = {
      comment: { body: '/agent' },
      issue: { number: 5 },
      repository: { full_name: 'org/repo' },
    };
    const result = composeCommandTriggerPrompt(payload);
    expect(result).not.toContain('/agent');
    expect(result).toContain('#5');
    expect(result).toContain('org/repo');
  });

  it('strips /agent followed by newline', () => {
    const payload: IssueCommentPayload = {
      comment: { body: '/agent\ndo something complex' },
      issue: { number: 10 },
      repository: { full_name: 'x/y' },
    };
    const result = composeCommandTriggerPrompt(payload);
    expect(result).not.toMatch(/\/agent/);
    expect(result).toContain('do something complex');
  });

  it('does not strip /agent when embedded mid-word', () => {
    const payload: IssueCommentPayload = {
      comment: { body: '/agentsmith is here' },
      issue: { number: 3 },
      repository: { full_name: 'a/b' },
    };
    const result = composeCommandTriggerPrompt(payload);
    expect(result).toContain('/agentsmith is here');
  });

  it('includes repo and PR number', () => {
    const payload: IssueCommentPayload = {
      comment: { body: '/agent deploy' },
      issue: { number: 77 },
      repository: { full_name: 'acme/widget' },
    };
    const result = composeCommandTriggerPrompt(payload);
    expect(result).toContain('acme/widget');
    expect(result).toContain('#77');
  });
});

describe('composeCronTaskPrompt', () => {
  it('includes task text, repo, and roadmap path', () => {
    const result = composeCronTaskPrompt(
      'Implement user authentication',
      'myorg/myrepo',
      './ROADMAP.md',
    );
    expect(result).toContain('Implement user authentication');
    expect(result).toContain('myorg/myrepo');
    expect(result).toContain('./ROADMAP.md');
  });

  it('handles empty task text', () => {
    const result = composeCronTaskPrompt('', 'org/repo', './tasks.md');
    expect(result).toContain('org/repo');
    expect(result).toContain('./tasks.md');
  });
});
