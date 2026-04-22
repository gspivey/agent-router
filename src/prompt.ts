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
  throw new Error('Not implemented');
}

export function composeReviewCommentPrompt(payload: ReviewCommentPayload): string {
  throw new Error('Not implemented');
}

export function composeCommandTriggerPrompt(payload: IssueCommentPayload): string {
  throw new Error('Not implemented');
}

export function composeCronTaskPrompt(
  task: string,
  repo: string,
  roadmapPath: string
): string {
  throw new Error('Not implemented');
}
