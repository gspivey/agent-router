import { test, expect } from '@playwright/test';
import { createWebApp } from '../../src/web-server.js';

test('module resolution: createWebApp is importable via .js extension', () => {
  expect(typeof createWebApp).toBe('function');
});
