// The two-org fixture ORG-02/03/04 drive from (PRD 10 §1.5, R-286c). Org A is
// the attacker's, org B the victim's; each gets one row of every model the
// manifest names, plus an owner, a tenant and a guarantor to act as.
//
// Rows are built from Prisma's own schema metadata, not by hand: every
// required scalar gets a plain value and every required relation gets a
// parent, made the same way and shared within the org, so one org is one
// coherent graph (the lease's unit is on the lease's property). A model a
// later row adds to the manifest gets its fixture row for free. `OVERRIDES`
// is only for what the metadata cannot see: CHECK constraints and triggers.
//
// Nothing is deleted afterwards. Own-org calls write append-only rows
// (AuditLog, Message, Notification) that pin everything they reference, so the
// orgs stay, with their properties deactivated: that is the marker
// notifications.test.ts reads as "a finished spec" (R-109).
import { Prisma, prisma } from '@rental/db'

export type Org = {
  key: string
  id: string
  owner: string
  tenant: string
  guarantor: string
  rows: Map<string, string>
}

type Field = Prisma.DMMF.Field
const MODELS = new Map(Prisma.dmmf.datamodel.models.map((m) => [m.name, m]))
const ENUMS = new Map(Prisma.dmmf.datamodel.enums.map((e) => [e.name, e.values.map((v) => v.name)]))
const lower = (m: string) => m[0]!.toLowerCase() + m.slice(1)
const upper = (m: string) => m[0]!.toUpperCase() + m.slice(1)

// What the schema cannot say. Each entry names the constraint it satisfies.
const OVERRIDES: Record<string, (o: Org) => Promise<Record<string, unknown>>> = {
  // Prospect_contact_check: an email or a phone.
  Prospect: async (o) => ({ email: `org-harness-${o.key}-prospect-${Date.now()}@example.test` }),
  // ComplianceItem_scope_check: exactly one of property and entity.
  ComplianceItem: async (o) => ({ propertyId: await rowOf(o, 'property') }),
  // Notice_lease_xor_applicant_check.
  Notice: async (o) => ({ leaseId: await rowOf(o, 'lease') }),
  // A triage task names its ticket (ticketTriageTaskOrThrow); the generic
  // `subjectType` string names nothing.
  Task: async (o) => ({ subjectType: 'Ticket', subjectId: await rowOf(o, 'ticket') }),
  // A tenant's own conversation, and a report the tenant completes
  // themselves: the portal actions find nothing otherwise.
  Thread: async (o) => ({ tenantId: await rowOf(o, 'tenant') }),
  Ticket: async (o) => ({ tenantId: await rowOf(o, 'tenant') }),
  Inspection: async () => ({ selfGuided: true }),
  // An invoice to mark paid, and the tenant's ticket behind it.
  WorkOrder: async (o) => ({ invoiceCents: 10000, ticketId: await rowOf(o, 'ticket') }),
  // A recurrence to stop.
  PropertyExpense: async () => ({ recursMonthly: true }),
  // TenantConsent_one_subject and _express_needs_disclosure.
  TenantConsent: async (o) => ({ tenantId: await rowOf(o, 'tenant'), disclosureText: 'Reply STOP to opt out.' }),
}

const CORE = new Set(['propertyId', 'unitId', 'leaseId'])

// Rows being built right now, so an optional link back to one (a unit's
// current lease, whose unit is this one) is left empty rather than recursed.
const making = new Set<string>()
let seq = 0
function scalar(model: string, f: Field, o: Org): unknown {
  const tag = `org-harness-${o.key}-${lower(model)}-${f.name}-${++seq}-${Date.now()}`
  if (f.kind === 'enum') return ENUMS.get(f.type)![0]
  switch (f.type) {
    case 'String':
      if (/email/i.test(f.name)) return `${tag}@example.test`
      if (/phone/i.test(f.name)) return `+1555${String(Date.now() + seq).slice(-7)}`
      if (/timezone/i.test(f.name)) return 'America/Chicago'
      if (/^state$/.test(f.name)) return 'TX'
      return tag
    case 'Int':
    case 'Float':
    case 'Decimal':
      return 1
    case 'BigInt':
      return 1n
    case 'Boolean':
      // An inactive row is refused by everything that reads it.
      return f.name === 'active'
    case 'DateTime':
      return new Date('2026-01-01T00:00:00Z')
    case 'Json':
      return {}
    case 'Bytes':
      return new Uint8Array([1])
    default:
      throw new Error(`fixture: cannot fill ${model}.${f.name} (${f.type})`)
  }
}

/** The id of org `o`'s row of `model`, creating it (and its parents) on first use. */
export async function rowOf(o: Org, model: string): Promise<string> {
  const name = upper(model)
  const have = o.rows.get(name)
  if (have) return have
  if (name === 'Organization') return o.id
  const meta = MODELS.get(name)
  if (!meta) throw new Error(`fixture: no model ${name}`)
  // An org-less table is shared by every test file (a stray Role broke the
  // seeded-roles test), so its rows are seedOrg's to name, never made here.
  if (!meta.fields.some((f) => f.name === 'orgId')) throw new Error(`fixture: ${name} is org-less; set its row in seedOrg`)

  making.add(`${o.key}:${name}`)
  const data: Record<string, unknown> = {}
  const fks = new Set<string>()
  for (const f of meta.fields) {
    if (f.kind !== 'object' || !f.relationFromFields?.length) continue
    f.relationFromFields.forEach((k) => fks.add(k))
    const required = f.relationFromFields.every((k) => meta.fields.find((s) => s.name === k)!.isRequired)
    // An optional link to the org's core graph is filled too: an inspection
    // with no lease, or a job run with no property, is refused by every
    // action before its lookup and proves nothing.
    if (!required && (!CORE.has(f.relationFromFields[0]!) || making.has(`${o.key}:${f.type}`))) continue
    // ponytail: single-column foreign keys to `id`; a composite key throws here.
    if (f.relationFromFields.length !== 1) throw new Error(`fixture: composite key ${name}.${f.name}`)
    data[f.relationFromFields[0]!] = await rowOf(o, f.type)
  }
  for (const f of meta.fields) {
    if (f.kind === 'object' || fks.has(f.name) || f.isId || f.isUpdatedAt || f.isList) continue
    if (f.name === 'orgId') data.orgId = o.id
    else if (f.isRequired && !f.hasDefaultValue) data[f.name] = scalar(name, f, o)
  }
  Object.assign(data, await OVERRIDES[name]?.(o))

  const delegate = (prisma as unknown as Record<string, { create: (a: unknown) => Promise<{ id: string }> }>)[lower(name)]!
  let id: string
  try {
    ;({ id } = await delegate.create({ data, select: { id: true } }))
  } catch (e) {
    throw new Error(`fixture: creating ${name} failed (add an OVERRIDES entry): ${(e as Error).message.slice(-400)}`)
  }
  making.delete(`${o.key}:${name}`)
  o.rows.set(name, id)
  return id
}

async function seedOrg(key: string): Promise<Org> {
  const stamp = `org-harness-${key}-${Date.now()}`
  const org = await prisma.organization.create({ data: { slug: stamp, name: `Org ${key.toUpperCase()}` } })
  const o: Org = { key, id: org.id, owner: '', tenant: '', guarantor: '', rows: new Map() }

  const owner = await prisma.role.findUniqueOrThrow({ where: { key: 'owner' } })
  // Roles are seeded system rows (ORG-06's allowlist), never the fixture's to make.
  o.rows.set('Role', owner.id)
  o.owner = (
    await prisma.staffUser.create({
      data: {
        email: `${stamp}-owner@example.test`,
        name: `Owner ${key.toUpperCase()}`,
        orgMemberships: { create: { orgId: org.id } },
        assignments: { create: { orgId: org.id, roleId: owner.id } },
      },
    })
  ).id
  // A second staff member for actions that name one (assign, revoke).
  // An owner too, so a pick of "who works these tasks" accepts them.
  const staff = await prisma.staffUser.create({
    data: {
      email: `${stamp}-staff@example.test`,
      name: `Staff ${key.toUpperCase()}`,
      orgMemberships: { create: { orgId: org.id } },
      assignments: { create: { orgId: org.id, roleId: owner.id } },
    },
  })
  o.rows.set('StaffUser', staff.id)

  // The tenant is on the lease, so a tenant action has a tenancy to act on.
  await rowOf(o, 'leaseTenant')
  o.tenant = await rowOf(o, 'tenant')
  o.guarantor = await rowOf(o, 'guarantor')
  return o
}

/** One org with a row of each model, its owner, tenant and guarantor. */
export async function seedOrgWith(key: string, models: string[]): Promise<Org> {
  const o = await seedOrg(key)
  for (const m of models) await rowOf(o, m)
  return o
}

export async function retire(orgs: Org[]) {
  await prisma.property.updateMany({ where: { orgId: { in: orgs.map((o) => o.id) } }, data: { active: false } })
}
