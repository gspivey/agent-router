/**
 * Browser test: Projects panel and repo filter (ROADMAP #55, tasks 6, 7, 8).
 *
 * Validates:
 * - Projects panel renders when repos exist (ungrouped section)
 * - Panel is accessible (aria-expanded, role attributes)
 * - Clicking a repo filters the session list
 * - Clear button restores full list
 * - Collapse/expand toggle works
 * - No console errors during interaction
 */
import { test, expect } from './fixtures.js';

test('projects panel shows ungrouped repo when no projects configured', async ({ page, baseUrl, seedSession }) => {
  await seedSession({ live: false, status: 'completed' });
  await page.goto(baseUrl);

  // Wait for the projects panel to render (ungrouped section with the fixture repo)
  const panel = page.locator('#projects-panel');
  await expect(panel).toBeVisible({ timeout: 5000 });

  // Should have an Ungrouped section with test-org/test-repo
  const ungroupedHeading = page.locator('text=Ungrouped');
  await expect(ungroupedHeading).toBeVisible();

  const repoItem = page.locator('.project-repo-item', { hasText: 'test-org/test-repo' });
  await expect(repoItem).toBeVisible();
});

test('projects panel has correct ARIA attributes', async ({ page, baseUrl, seedSession }) => {
  await seedSession({ live: false, status: 'completed' });
  await page.goto(baseUrl);

  const panel = page.locator('#projects-panel');
  await expect(panel).toBeVisible({ timeout: 5000 });

  // Section should have role="region" and aria-labelledby
  const section = page.locator('.project-section[role="region"]');
  await expect(section).toBeVisible();

  // Header should have aria-expanded
  const header = page.locator('.project-header[aria-expanded]');
  await expect(header).toBeVisible();
  await expect(header).toHaveAttribute('aria-expanded', 'true');
});

test('clicking a repo in the panel filters the session list', async ({ page, baseUrl, seedSession }) => {
  await seedSession({ live: false, status: 'completed', repo: 'test-org/test-repo' });
  await page.goto(baseUrl);

  // Wait for panel and sessions
  await page.waitForSelector('#projects-panel .project-repo-item', { timeout: 5000 });
  await page.waitForSelector('.session-item', { timeout: 5000 });

  // Click the repo item
  await page.locator('.project-repo-item', { hasText: 'test-org/test-repo' }).click();

  // The repo filter bar should appear
  const filterBar = page.locator('#repo-filter .repo-filter-bar');
  await expect(filterBar).toBeVisible({ timeout: 3000 });
  await expect(filterBar).toContainText('test-org/test-repo');

  // Clear button should exist
  const clearBtn = page.locator('#clear-repo-filter');
  await expect(clearBtn).toBeVisible();
});

test('clearing the repo filter restores the full session list', async ({ page, baseUrl, seedSession }) => {
  await seedSession({ live: false, status: 'completed', repo: 'test-org/test-repo' });
  await page.goto(baseUrl);

  // Wait for panel
  await page.waitForSelector('#projects-panel .project-repo-item', { timeout: 5000 });
  await page.waitForSelector('.session-item', { timeout: 5000 });

  // Set filter
  await page.locator('.project-repo-item', { hasText: 'test-org/test-repo' }).click();
  await page.waitForSelector('#repo-filter .repo-filter-bar', { timeout: 3000 });

  // Clear filter
  await page.locator('#clear-repo-filter').click();

  // Filter bar should be hidden
  const filterBar = page.locator('#repo-filter');
  await expect(filterBar).toBeHidden({ timeout: 3000 });

  // Grouped sessions view should re-appear (repo-section is the grouped view indicator)
  await page.waitForSelector('.repo-section', { timeout: 5000 });
});

test('collapse/expand toggle works on project sections', async ({ page, baseUrl, seedSession }) => {
  await seedSession({ live: false, status: 'completed' });
  await page.goto(baseUrl);

  await page.waitForSelector('#projects-panel .project-header', { timeout: 5000 });

  const header = page.locator('.project-header').first();
  const section = page.locator('.project-section').first();

  // Initially expanded
  await expect(header).toHaveAttribute('aria-expanded', 'true');
  await expect(section).not.toHaveClass(/collapsed/);

  // Click to collapse
  await header.click();
  await expect(header).toHaveAttribute('aria-expanded', 'false');
  await expect(section).toHaveClass(/collapsed/);

  // Click to expand again
  await header.click();
  await expect(header).toHaveAttribute('aria-expanded', 'true');
  await expect(section).not.toHaveClass(/collapsed/);
});

test('no console errors during projects panel interaction', async ({ page, baseUrl, seedSession, console: collector }) => {
  await seedSession({ live: false, status: 'completed' });
  await page.goto(baseUrl);

  await page.waitForSelector('#projects-panel .project-repo-item', { timeout: 5000 });

  // Click repo to filter
  await page.locator('.project-repo-item').first().click();
  await page.waitForTimeout(500);

  // Clear filter
  const clearBtn = page.locator('#clear-repo-filter');
  if (await clearBtn.isVisible()) {
    await clearBtn.click();
    await page.waitForTimeout(300);
  }

  collector.assertNoErrors();
});

test('existing session list pagination still works with projects panel present', async ({ page, baseUrl, seedSession }) => {
  // Create enough sessions to trigger "Show more"
  for (let i = 0; i < 8; i++) {
    await seedSession({ live: false, status: 'completed' });
  }
  await page.goto(baseUrl);

  // Projects panel should be visible
  await expect(page.locator('#projects-panel')).toBeVisible({ timeout: 5000 });

  // Repo section (grouped view) should also appear
  await page.waitForSelector('.repo-section', { timeout: 5000 });

  // Show more button should appear (default per-repo limit is 5)
  const showMoreBtn = page.locator('.show-more-btn');
  await expect(showMoreBtn).toBeVisible({ timeout: 3000 });
});

test('SSE streaming to detail view still works with projects panel present', async ({ page, baseUrl, seedSession }) => {
  const { sessionId } = await seedSession({ live: true });
  await page.goto(baseUrl);

  // Navigate to detail view
  await page.goto(`${baseUrl}#/sessions/${sessionId}`);
  await page.waitForSelector('#log-container', { timeout: 5000 });

  // SSE status should show connected
  const sseStatus = page.locator('#sse-status');
  await expect(sseStatus).toContainText('Connected', { timeout: 5000 });
});
