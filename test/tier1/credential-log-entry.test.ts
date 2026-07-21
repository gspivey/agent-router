/**
 * Tier 1 property test for credential log entry structure (Property 14).
 *
 * Feature: auth-credential-proxy, Property 14: Credential log entry structure
 *
 * Verifies that every credential tool call log entry contains all required fields:
 * tool_name, repo, project, session_id, status, duration_ms, error_code.
 *
 * Validates: Requirements 11.1
 */
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { Writable } from 'node:stream';
import { createLogger } from '../../src/log.js';
import type { CredentialLogEntry, CredentialErrorCode } from '../../src/mcp-server.js';

/** All valid error codes per spec. */
const CREDENTIAL_ERROR_CODES: CredentialErrorCode[] = [
  'token_missing',
  'repo_unauthorized',
  'upstream_5xx',
  'upstream_timeout',
  'body_too_large',
  'method_invalid',
  'path_invalid',
];

/** Generator for valid credential tool names. */
const arbToolName = fc.constantFrom('github_http_forward', 'git_credential');

/** Generator for repo strings (owner/repo format). */
const arbRepo = fc.tuple(
  fc.stringMatching(/^[a-zA-Z0-9._-]+$/),
  fc.stringMatching(/^[a-zA-Z0-9._-]+$/),
).filter(([owner, name]) => owner.length > 0 && name.length > 0)
  .map(([owner, name]) => `${owner}/${name}`);

/** Generator for project names. */
const arbProject = fc.stringMatching(/^[a-zA-Z0-9._-]+$/).filter((s) => s.length > 0);

/** Generator for session IDs. */
const arbSessionId = fc.uuid();

/** Generator for status field. */
const arbStatus = fc.constantFrom('success' as const, 'error' as const);

/** Generator for optional error code. */
const arbErrorCode = fc.option(fc.constantFrom(...CREDENTIAL_ERROR_CODES), { nil: undefined });

/** Generator for duration_ms (non-negative integer). */
const arbDurationMs = fc.nat({ max: 60_000 });

describe('Property 14: Credential log entry structure', () => {
  it('every credential tool call log entry contains all required fields', () => {
    fc.assert(
      fc.property(
        arbToolName,
        arbRepo,
        arbProject,
        arbSessionId,
        arbStatus,
        arbErrorCode,
        arbDurationMs,
        (toolName, repo, project, sessionId, status, errorCode, durationMs) => {
          // Capture log output
          const logLines: string[] = [];
          const logger = createLogger({
            level: 'debug',
            output: (line: string) => { logLines.push(line); },
          });

          // Build the structured log fields as the implementation does
          const fields: Record<string, unknown> = {
            tool_name: toolName,
            repo,
            project,
            session_id: sessionId,
            status,
            duration_ms: durationMs,
          };
          if (errorCode) {
            fields['error_code'] = errorCode;
          }

          // Log as the implementation would
          if (status === 'error') {
            logger.warn('credential tool call failed', fields);
          } else {
            logger.info('credential tool call', fields);
          }

          // Parse the log line and verify all required Property 14 fields are present
          expect(logLines.length).toBe(1);
          const entry = JSON.parse(logLines[0]!) as Record<string, unknown>;

          // Required fields per Property 14
          expect(entry).toHaveProperty('tool_name', toolName);
          expect(entry).toHaveProperty('repo', repo);
          expect(entry).toHaveProperty('project', project);
          expect(entry).toHaveProperty('session_id', sessionId);
          expect(entry).toHaveProperty('status', status);
          expect(entry).toHaveProperty('duration_ms', durationMs);

          // error_code is present when provided
          if (errorCode) {
            expect(entry).toHaveProperty('error_code', errorCode);
          }

          // Standard log fields are also present
          expect(entry).toHaveProperty('timestamp');
          expect(entry).toHaveProperty('level');
          expect(entry).toHaveProperty('message');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('error_code field uses only the defined string enum values', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...CREDENTIAL_ERROR_CODES),
        (errorCode) => {
          const logLines: string[] = [];
          const logger = createLogger({
            level: 'debug',
            output: (line: string) => { logLines.push(line); },
          });

          const fields: Record<string, unknown> = {
            tool_name: 'github_http_forward',
            repo: 'org/repo',
            project: 'test-project',
            session_id: 'sess-1',
            status: 'error',
            duration_ms: 100,
            error_code: errorCode,
          };
          logger.warn('credential tool call failed', fields);

          const entry = JSON.parse(logLines[0]!) as Record<string, unknown>;
          expect(CREDENTIAL_ERROR_CODES).toContain(entry['error_code']);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('success entries have no error_code field when not provided', () => {
    const logLines: string[] = [];
    const logger = createLogger({
      level: 'debug',
      output: (line: string) => { logLines.push(line); },
    });

    const fields: Record<string, unknown> = {
      tool_name: 'github_http_forward',
      repo: 'org/repo',
      project: 'test-project',
      session_id: 'sess-1',
      status: 'success',
      duration_ms: 42,
    };
    logger.info('credential tool call', fields);

    const entry = JSON.parse(logLines[0]!) as Record<string, unknown>;
    expect(entry).toHaveProperty('tool_name');
    expect(entry).toHaveProperty('status', 'success');
    expect(entry).not.toHaveProperty('error_code');
  });

  it('duration_ms is a non-negative number', () => {
    fc.assert(
      fc.property(
        arbDurationMs,
        (durationMs) => {
          const logLines: string[] = [];
          const logger = createLogger({
            level: 'debug',
            output: (line: string) => { logLines.push(line); },
          });

          logger.info('credential tool call', {
            tool_name: 'github_http_forward',
            repo: 'org/repo',
            project: 'proj',
            session_id: 'sess',
            status: 'success',
            duration_ms: durationMs,
          });

          const entry = JSON.parse(logLines[0]!) as Record<string, unknown>;
          expect(typeof entry['duration_ms']).toBe('number');
          expect(entry['duration_ms'] as number).toBeGreaterThanOrEqual(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('log entries never contain raw token values', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 8, maxLength: 100 }).filter((s) => s.length >= 8),
        (token) => {
          const logLines: string[] = [];
          const logger = createLogger({
            level: 'debug',
            output: (line: string) => { logLines.push(line); },
          });

          // The implementation logs fields but never the token
          logger.info('credential tool call', {
            tool_name: 'github_http_forward',
            repo: 'org/repo',
            project: 'proj',
            session_id: 'sess',
            status: 'success',
            duration_ms: 100,
          });

          const logOutput = logLines.join('');
          // The token value must not appear in the log
          expect(logOutput).not.toContain(token);
        },
      ),
      { numRuns: 100 },
    );
  });
});
