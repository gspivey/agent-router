/**
 * Module resolution smoke test.
 * Proves that createWebApp is importable via .js extension (ESM resolution check).
 * Spec: .kiro/specs/browser-test-harness-v2/ · task 3.1
 */
import { test, expect } from '@playwright/test';
import { createWebApp } from '../../src/web-server.js';

test('module resolution: createWebApp is importable via .js extension', () => {
  expect(typeof createWebApp).toBe('function');
});
