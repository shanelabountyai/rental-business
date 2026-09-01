import { chromium } from '@playwright/test'
import fs from 'node:fs'

const BASE = 'http://localhost:3100'
const OUT = '/tmp/demo-shots'
const ids = JSON.parse(fs.readFileSync('/tmp/ids.json', 'utf8'))

const SCREENS = [
  ['login',            '/login',                              'Sign in'],
  ['dashboard',        '/dashboard',                          'Portfolio dashboard'],
  ['properties',       '/properties',                         'Properties'],
  ['property',         `/properties/${ids.property}`,         'One property'],
  ['entities',         '/properties/entities',                'Legal entities'],
  ['vacancies',        '/vacancies',                          'Vacancies'],
  ['leases',           '/leases',                             'Leases'],
  ['lease',            `/leases/${ids.lease}`,                'One lease'],
  ['renewals',         '/renewals',                           'Renewals'],
  ['prospects',        '/prospects',                          'Prospects'],
  ['maintenance',      '/maintenance',                        'Maintenance queue'],
  ['ticket',           `/maintenance/${ids.ticket}`,          'One ticket'],
  ['preventive',       '/maintenance/preventive',             'Preventive maintenance'],
  ['workorders',       '/workorders',                         'Work orders'],
  ['workorder',        `/workorders/${ids.workorder}`,        'One work order'],
  ['vendors',          '/vendors',                            'Vendors'],
  ['money-rent-roll',  '/money/rent-roll',                    'Rent roll'],
  ['money-invoices',   '/money/vendor-invoices',              'Vendor invoices'],
  ['notices',          '/notices',                            'Notices'],
  ['evictions',        '/evictions',                          'Evictions'],
  ['violations',       '/violations',                         'Violations'],
  ['inspections',      '/inspections',                        'Inspections'],
  ['tasks',            '/tasks',                              'Task queue'],
  ['messages',         '/messages',                           'Messages'],
  ['documents',        '/documents',                          'Documents'],
  ['reports-operating','/reports/operating',                  'Operating report'],
  ['reports-tax',      '/reports/tax',                        'Tax packet'],
  ['reports-leasing',  '/reports/leasing',                    'Leasing funnel'],
  ['jurisdiction',     '/jurisdiction',                       'Jurisdiction rules'],
  ['staff',            '/staff',                              'Staff & roles'],
  ['notifications',    '/notifications',                      'Notification settings'],
  ['compliance',       '/compliance',                         'Compliance'],
]

const ip = () => `203.0.113.${Math.floor(Math.random() * 250) + 1}`

const browser = await chromium.launch()
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
  extraHTTPHeaders: { 'x-forwarded-for': ip() },
})
const page = await ctx.newPage()
const results = []

async function shot(slug, path, title) {
  const url = BASE + path
  const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => null)
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {})
  const status = res ? res.status() : 0
  const h1 = await page.locator('h1').first().textContent({ timeout: 5_000 }).catch(() => null)
  const file = `${OUT}/${slug}.png`
  await page.screenshot({ path: file, fullPage: true })
  const bytes = fs.statSync(file).size
  results.push({ slug, path, title, status, heading: (h1 || '').trim(), bytes })
  console.log(`${String(status).padEnd(4)} ${slug.padEnd(20)} ${(h1 || '(no h1)').trim().slice(0, 46)}`)
}

// 1. the signed-out front door
await shot('login', '/login', 'Sign in')

// 2. sign in as the owner
await page.goto(BASE + '/login')
await page.getByLabel(/email/i).fill('owner@demo.test')
await page.getByLabel(/password/i).fill('demo-rental-2026')
await page.getByRole('button', { name: /sign in/i }).click()
await page.waitForURL('**/dashboard', { timeout: 45_000 })
console.log('--- signed in ---')

for (const [slug, path, title] of SCREENS.slice(1)) {
  try { await shot(slug, path, title) }
  catch (e) { console.log(`FAIL ${slug}: ${String(e).slice(0, 90)}`); results.push({ slug, path, title, status: -1, heading: '', bytes: 0 }) }
}

fs.writeFileSync('/tmp/demo-shots/manifest.json', JSON.stringify(results, null, 2))
await browser.close()
console.log(`\ncaptured ${results.filter(r => r.bytes > 0).length}/${SCREENS.length}`)
