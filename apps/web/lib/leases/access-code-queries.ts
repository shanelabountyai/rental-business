import 'server-only'

import { type AccessCode, prisma } from '@rental/db'

// Reads for keys/codes at move-in (INSP-01, R-069).

export interface AccessCodeWithIssuance extends AccessCode {
  issuedAt: Date | null
}

/// Every current code on the unit, each carrying the last time it was
/// issued to THIS lease specifically (derived from AuditLog, never a stored
/// column - the same "derive, don't duplicate" call LeaseStatus's own
/// history already makes). Null means never issued to this tenancy, even if
/// an earlier tenant on the same unit received a since-superseded version.
export async function accessCodesForLease(
  unitId: string,
  leaseId: string,
): Promise<AccessCodeWithIssuance[]> {
  const [codes, issuances] = await Promise.all([
    prisma.accessCode.findMany({ where: { unitId, effectiveTo: null }, orderBy: { type: 'asc' } }),
    prisma.auditLog.findMany({
      where: { entityType: 'Lease', entityId: leaseId, action: 'accesscode.issued' },
      orderBy: { occurredAt: 'desc' },
      select: { after: true, occurredAt: true },
    }),
  ])

  const issuedAt = new Map<string, Date>()
  for (const row of issuances) {
    const after = row.after as { accessCodeId?: string } | null
    const id = after?.accessCodeId
    // Newest first, so the first row seen per code is its most recent
    // issuance - a reissued code keeps only that one visible.
    if (id && !issuedAt.has(id)) issuedAt.set(id, row.occurredAt)
  }

  return codes.map((code) => ({ ...code, issuedAt: issuedAt.get(code.id) ?? null }))
}
