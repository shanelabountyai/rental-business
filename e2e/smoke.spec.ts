import { expect, test } from '@playwright/test'
import { axeScan } from './fixtures.ts'

// The accessibility gate exists from the first commit on purpose. CLAUDE.md
// treats WCAG 2.1 AA as an acceptance criterion rather than a later cleanup,
// and a gate added after twenty screens are built is a gate that gets waived.
test('home renders and has no detectable accessibility violations', async ({
  page,
}) => {
  await page.goto('/')

  await expect(
    page.getByRole('heading', { name: 'Rental Operations Platform', level: 1 }),
  ).toBeVisible()

  const results = await axeScan(page)

  expect(results.violations).toEqual([])
})

// R-114 (audit angle 8). This route rendered "Scaffold only", named a backlog
// file, and printed worked proration and late-fee-cap arithmetic - on the one
// URL a stranger reaches by typing the domain, with no way onward from it.
// Both assertions matter: the links are what the page is for, and the absence
// is what stops the next person restoring a convenient debug panel here.
test('the front door points at both sign-ins and leaks no build notes', async ({
  page,
}) => {
  await page.goto('/')

  await expect(page.getByRole('link', { name: /portal/i })).toHaveAttribute(
    'href',
    '/portal/login',
  )
  await expect(page.getByRole('link', { name: /staff sign in/i })).toHaveAttribute(
    'href',
    '/login',
  )

  await expect(page.getByText(/scaffold/i)).toHaveCount(0)
  await expect(page.getByText(/docs\/prds/i)).toHaveCount(0)
})
