import { randomUUID } from 'node:crypto'
import { createTotpEnrolment, hashPassword, sealSecret } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'
import { Secret, TOTP } from 'otpauth'
import { uniquePhone } from './fixtures.ts'

// Managed message templates (COMM-03, R-049).
//
// ==========================================================================
// TWO THINGS ONLY A BROWSER PROVES.
//
//   THE PREVIEW IS LIVE AND RENDERS REAL DATA. It is COMM-03's own acceptance
//   criterion, it is the only thing standing between a typo'd merge field and
//   four hundred tenants, and it is entirely a client-side behaviour.
//
//   A MANAGER CANNOT APPROVE A LEGAL TRANSLATION. `template.approve` is its
//   own privileged permission precisely so the person who pasted in a machine
//   translation cannot mark their own work approved. If that split were only
//   in a comment, the button would render for the wrong person.
// ==========================================================================

const PASSWORD = 'correct-horse-battery-staple'

const entityIds: string[] = []
const propertyIds: string[] = []
const unitIds: string[] = []
const tenantIds: string[] = []
const staffIds: string[] = []
const templateIds: string[] = []

/// A live tenancy, so the preview has real data to render against.
async function seedTenancy() {
  const stamp = randomUUID().slice(0, 8)
  const entity = await prisma.legalEntity.create({
    data: { name: `Tpl LLC-${stamp}`, type: 'LLC' },
  })
  entityIds.push(entity.id)
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `Tpl House-${stamp}`,
      addressLine1: '7 Template Way',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyIds.push(property.id)
  const unit = await prisma.unit.create({
    data: { propertyId: property.id, name: `U-${stamp}`, status: 'OCCUPIED' },
  })
  unitIds.push(unit.id)
  const tenant = await prisma.tenant.create({
    data: { firstName: 'Marisol', lastName: `Tpl-${stamp}`, phone: uniquePhone() },
  })
  tenantIds.push(tenant.id)
  const lease = await prisma.lease.create({
    data: {
      propertyId: property.id,
      unitId: unit.id,
      status: 'ACTIVE',
      // Newest start date, so `previewTenancy` picks THIS tenancy and the
      // assertions below can name it.
      startsOn: new Date('2099-01-01'),
      // Month-to-month in substance: no end date, which is what makes
      // `{{lease.ends_on}}` genuinely empty rather than artificially so.
      endsOn: null,
      rentCents: 150_000,
    },
  })
  await prisma.leaseTenant.create({ data: { leaseId: lease.id, tenantId: tenant.id } })
  return { property, tenant, lease }
}

async function seedStaff(role: 'owner' | 'manager') {
  const email = `tpl-${role}-${randomUUID()}@example.test`
  const { secret } = createTotpEnrolment(email)
  const staff = await prisma.staffUser.create({
    data: {
      email,
      name: role === 'owner' ? 'Template Owner' : 'Template Manager',
      credential: {
        create: {
          passwordHash: await hashPassword(PASSWORD),
          // Enrolled for both. `template.approve` is privileged, and the
          // manager needs a comparable session for the comparison to be about
          // PERMISSIONS rather than about MFA.
          mfaSecret: sealSecret(secret),
          mfaEnrolledAt: new Date(),
        },
      },
    },
  })
  staffIds.push(staff.id)
  const roleRow = await prisma.role.findUniqueOrThrow({ where: { key: role } })
  await prisma.staffAssignment.create({
    data: { staffUserId: staff.id, roleId: roleRow.id },
  })
  return { ...staff, secret }
}

async function signIn(
  page: import('@playwright/test').Page,
  staff: { email: string; secret: string },
) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(staff.email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL(/\/login\/mfa/)
  await page
    .getByLabel(/code/i)
    .fill(new TOTP({ secret: Secret.fromBase32(staff.secret) }).generate())
  await page.getByRole('button', { name: 'Verify' }).click()
  await page.waitForURL('**/dashboard')
}

test.beforeEach(async ({ page }) => {
  const octet = () => Math.floor(Math.random() * 254) + 1
  await page.setExtraHTTPHeaders({
    'x-forwarded-for': `10.${octet()}.${octet()}.${octet()}`,
  })
})

test.describe('writing a template (COMM-03)', () => {
  test('THE PREVIEW RENDERS REAL DATA AS YOU TYPE, and names a field it cannot fill', async ({
    page,
  }) => {
    const { tenant } = await seedTenancy()
    await signIn(page, await seedStaff('owner'))
    await page.goto('/messages/templates/new')

    await page.getByLabel('Template name').fill('Rent reminder')
    await page
      .getByLabel('Message', { exact: true })
      .fill('Hi {{tenant.first_name}}, rent of {{lease.rent}} is due.')

    // SCOPED TO THE PREVIEW REGION, because the textarea holds the same words
    // the preview renders and an unscoped locator matches both — a strict-mode
    // violation that would otherwise be "fixed" by a .first() asserting the
    // input rather than the output.
    const preview = page.getByRole('region', { name: /would get/ })

    // Real data, not the catalogue's example values. Examples would make every
    // preview look perfect, which is the opposite of what a preview is for.
    await expect(
      preview.getByText(`Hi ${tenant.firstName}, rent of $1,500.00 is due.`),
    ).toBeVisible()

    // AND THE CASE THAT MATTERS. This tenancy has no end date, so the field
    // resolves to nothing — and the preview says which field, rather than
    // silently rendering "Your lease ends on ." to four hundred people.
    await page
      .getByLabel('Message', { exact: true })
      .fill('Your lease ends on {{lease.ends_on}}.')
    await expect(preview.getByText(/Nothing to put in \{\{lease\.ends_on\}\}/)).toBeVisible()
    // The token stays visible rather than becoming a blank — the two failure
    // modes the typed templates got for free.
    await expect(preview.getByText('Your lease ends on {{lease.ends_on}}.')).toBeVisible()
  })

  test('REFUSES A TYPO IN A MERGE FIELD, and names it', async ({ page }) => {
    await seedTenancy()
    await signIn(page, await seedStaff('owner'))
    await page.goto('/messages/templates/new')

    await page.getByLabel('Template name').fill('Broken')
    await page.getByLabel('Message', { exact: true }).fill('Hi {{tenant.frist_name}},')
    await page.getByRole('button', { name: 'Save template' }).click()

    // Validated on SAVE, because that is the last moment a human is present.
    await expect(page.getByText(/Not a merge field: \{\{tenant\.frist_name\}\}/)).toBeVisible()
    expect(await prisma.messageTemplate.count({ where: { name: 'Broken' } })).toBe(0)
  })

  test('saves a template and shows it in the library', async ({ page }) => {
    await seedTenancy()
    await signIn(page, await seedStaff('owner'))
    await page.goto('/messages/templates/new')

    const name = `Welcome packet ${randomUUID().slice(0, 6)}`
    await page.getByLabel('Template name').fill(name)
    await page.getByLabel('Subject line (email only)').fill('Welcome to {{property.name}}')
    await page
      .getByLabel('Message', { exact: true })
      .fill('Hi {{tenant.first_name}}, welcome to {{property.address}}.')
    await page.getByRole('button', { name: 'Save template' }).click()

    await page.waitForURL(/\/messages\/templates\/(?!new$)[a-z0-9]+$/)
    const saved = await prisma.messageTemplate.findFirstOrThrow({ where: { name } })
    templateIds.push(saved.id)
    expect(saved.kind).toBe('ROUTINE')

    await page.goto('/messages/templates')
    await expect(page.getByRole('link', { name })).toBeVisible()
  })
})

test.describe('approving a translation — the rule COMM-03 rests on', () => {
  async function seedLegalTemplateWithUnapprovedSpanish(staffId: string) {
    const template = await prisma.messageTemplate.create({
      data: {
        name: `Notice to vacate ${randomUUID().slice(0, 6)}`,
        kind: 'LEGAL',
        subject: null,
        body: 'You are required to vacate {{property.address}} by {{balance.due_on}}. This notice is a draft and is not legal advice.',
        createdByStaffId: staffId,
        translations: {
          create: {
            locale: 'es',
            body: 'Debe desalojar {{property.address}} antes del {{balance.due_on}}.',
            // NOT approved. The whole point.
            approvedAt: null,
          },
        },
      },
    })
    templateIds.push(template.id)
    return template
  }

  test('A MANAGER CANNOT APPROVE ONE — template.approve is its own privileged permission', async ({
    page,
  }) => {
    await seedTenancy()
    const manager = await seedStaff('manager')
    const template = await seedLegalTemplateWithUnapprovedSpanish(manager.id)

    await signIn(page, manager)
    await page.goto(`/messages/templates/${template.id}`)

    // A manager authors templates — that must still work, or this test would
    // pass for the wrong reason.
    await expect(page.getByLabel('Template name')).toBeVisible()
    // But cannot vouch for legal wording.
    await expect(
      page.getByRole('button', { name: 'Approve this translation' }),
    ).toHaveCount(0)
    await expect(page.getByText('Somebody with approval rights needs to review this.')).toBeVisible()
  })

  test('says plainly that an unapproved translation IS NOT BEING USED', async ({ page }) => {
    await seedTenancy()
    const owner = await seedStaff('owner')
    const template = await seedLegalTemplateWithUnapprovedSpanish(owner.id)

    await signIn(page, owner)
    await page.goto(`/messages/templates/${template.id}`)

    // Not inert, and not a harmless draft: tenants who read Spanish are
    // getting the English version, silently, until somebody is told.
    await expect(page.getByText(/not approved, so it is not being used/)).toBeVisible()
  })

  test('an owner approves it, and the reason is on the audit trail', async ({ page }) => {
    await seedTenancy()
    const owner = await seedStaff('owner')
    const template = await seedLegalTemplateWithUnapprovedSpanish(owner.id)

    await signIn(page, owner)
    await page.goto(`/messages/templates/${template.id}`)

    await page
      .getByLabel(/Who reviewed this/i)
      .fill('Reviewed by outside counsel, 14 August 2026.')
    await page.getByRole('button', { name: 'Approve this translation' }).click()

    await expect(page.getByText(/— approved/)).toBeVisible()

    const translation = await prisma.messageTemplateTranslation.findFirstOrThrow({
      where: { templateId: template.id, locale: 'es' },
    })
    expect(translation.approvedAt).not.toBeNull()
    expect(translation.approvedByStaffId).toBe(owner.id)

    // The product cannot verify an attorney read it. It can only record who
    // claimed so and why — which is why the action is on REASON_REQUIRED.
    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { entityId: translation.id, action: 'template.translation_approved' },
    })
    expect(entry.reason).toContain('outside counsel')
  })

  test('REFUSES TO APPROVE WITHOUT A STATED BASIS', async ({ page }) => {
    await seedTenancy()
    const owner = await seedStaff('owner')
    const template = await seedLegalTemplateWithUnapprovedSpanish(owner.id)

    await signIn(page, owner)
    await page.goto(`/messages/templates/${template.id}`)

    await page.getByLabel(/Who reviewed this/i).fill('ok')
    await page.getByRole('button', { name: 'Approve this translation' }).click()

    await expect(page.getByText(/Say who reviewed this and on what basis/)).toBeVisible()
    const translation = await prisma.messageTemplateTranslation.findFirstOrThrow({
      where: { templateId: template.id, locale: 'es' },
    })
    expect(translation.approvedAt).toBeNull()
  })

  test('EDITING A TRANSLATION CLEARS ITS APPROVAL', async ({ page }) => {
    await seedTenancy()
    const owner = await seedStaff('owner')
    const template = await seedLegalTemplateWithUnapprovedSpanish(owner.id)
    await prisma.messageTemplateTranslation.updateMany({
      where: { templateId: template.id },
      data: { approvedAt: new Date(), approvedByStaffId: owner.id },
    })

    await signIn(page, owner)
    await page.goto(`/messages/templates/${template.id}`)
    await expect(page.getByText(/— approved/)).toBeVisible()

    await page.getByText('Add or replace a translation').click()
    await page.getByLabel('Language code').fill('es')
    await page
      .getByLabel('Translated message')
      .fill('Debe desalojar {{property.address}} — texto revisado.')
    await page.getByRole('button', { name: 'Save translation' }).click()

    // Otherwise somebody approves a Spanish notice, reopens it, rewrites the
    // cure period, and the approved stamp still vouches for words nobody read.
    await expect(page.getByText(/still needs approving/)).toBeVisible()
    const translation = await prisma.messageTemplateTranslation.findFirstOrThrow({
      where: { templateId: template.id, locale: 'es' },
    })
    expect(translation.approvedAt).toBeNull()
    expect(translation.body).toContain('texto revisado')
  })
})

test.afterAll(async () => {
  // Translations cascade with their template; the template itself points at
  // staff with Restrict, so it goes before the staff are touched.
  await prisma.messageTemplate.deleteMany({ where: { id: { in: templateIds } } })
  await prisma.leaseTenant.deleteMany({ where: { tenantId: { in: tenantIds } } })
  await prisma.lease.deleteMany({ where: { propertyId: { in: propertyIds } } })
  await prisma.staffAssignment.deleteMany({ where: { staffUserId: { in: staffIds } } })
  await prisma.unit.deleteMany({ where: { id: { in: unitIds } } })
  // Deactivated, not deleted: these carry audit rows, and AuditLog refuses the
  // cascading update.
  await prisma.staffUser.updateMany({
    where: { id: { in: staffIds } },
    data: { active: false },
  })
  await prisma.property.updateMany({
    where: { id: { in: propertyIds } },
    data: { active: false },
  })
  await prisma.tenant.updateMany({
    where: { id: { in: tenantIds } },
    data: { active: false },
  })
  await prisma.$disconnect()
})
