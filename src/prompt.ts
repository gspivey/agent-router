export interface CheckRunPayload {
  check_run: {
    name: string;
    output: { summary: string | null };
    pull_requests: Array<{ number: number }>;
  };
  repository: { full_name: string };
}

export interface ReviewCommentPayload {
  comment: {
    body: string;
    diff_hunk: string;
    path: string;
  };
  pull_request: { number: number };
  repository: { full_name: string };
}

export interface IssueCommentPayload {
  comment: { body: string };
  issue: { number: number };
  repository: { full_name: string };
}

export function composeCheckRunPrompt(payload: CheckRunPayload): string {
  const prNumber = payload.check_run.pull_requests[0]?.number;
  const summary = payload.check_run.output.summary ?? '(no output summary)';
  return [
    `Check run "${payload.check_run.name}" failed.`,
    `Repository: ${payload.repository.full_name}`,
    `PR: #${prNumber ?? 'unknown'}`,
    `Output summary:`,
    summary,
  ].join('\n');
}

export function composeReviewCommentPrompt(payload: ReviewCommentPayload): string {
  return [
    `New review comment on PR #${payload.pull_request.number}.`,
    `Repository: ${payload.repository.full_name}`,
    `File: ${payload.comment.path}`,
    `Diff hunk:`,
    payload.comment.diff_hunk,
    `Comment:`,
    payload.comment.body,
  ].join('\n');
}

export function composeCommandTriggerPrompt(payload: IssueCommentPayload): string {
  const stripped = payload.comment.body.replace(/^\/agent(\s|$)/, '');
  return [
    `Agent command on PR #${payload.issue.number}.`,
    `Repository: ${payload.repository.full_name}`,
    `Command:`,
    stripped,
  ].join('\n');
}

export function composeCronTaskPrompt(
  task: string,
  repo: string,
  roadmapPath: string,
): string {
  return [
    `Cron task from roadmap.`,
    `Repository: ${repo}`,
    `Roadmap: ${roadmapPath}`,
    `Task:`,
    task,
  ].join('\n');
}
