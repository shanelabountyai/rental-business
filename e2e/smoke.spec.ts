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
