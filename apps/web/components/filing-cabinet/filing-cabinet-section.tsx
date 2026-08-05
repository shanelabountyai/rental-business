import type { HoaInfo, InsurancePolicy, Mortgage, Warranty } from '@rental/db'
import {
  insuranceRenewalDue,
  mortgageArmAdjustmentDue,
  mortgageBalloonMaturityDue,
} from '@rental/core/filing-cabinet'
import { AddInsurancePolicyForm } from '@/components/filing-cabinet/add-insurance-policy-form.tsx'
import { AddMortgageForm } from '@/components/filing-cabinet/add-mortgage-form.tsx'
import { AddWarrantyForm } from '@/components/filing-cabinet/add-warranty-form.tsx'
import { CostBasisForm } from '@/components/filing-cabinet/cost-basis-form.tsx'
import { HoaInfoForm } from '@/components/filing-cabinet/hoa-info-form.tsx'
import { DeleteRowButton } from '@/components/operational/delete-row-button.tsx'
import {
  addInsurancePolicy,
  addMortgage,
  addWarranty,
  deleteInsurancePolicy,
  deleteMortgage,
  deleteWarranty,
  setCostBasis,
  setHoaInfo,
} from '@/lib/filing-cabinet/actions.ts'

const WARRANTY_CATEGORY_LABELS: Record<string, string> = {
  ROOF: 'Roof',
  HVAC: 'HVAC',
  WATER_HEATER: 'Water heater',
  APPLIANCE: 'Appliance',
  HOME_WARRANTY: 'Home warranty',
  OTHER: 'Other',
}

function dollars(cents: number | null): string {
  return cents == null ? '—' : `$${(cents / 100).toLocaleString()}`
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/// A small inline flag, not a notification - the real delivery of these
/// alerts belongs to the compliance calendar (R-077) and notification engine
/// (R-016), neither of which exists yet. This is the "report" half of the
/// "report, not automated action" pattern documents/retention.ts established.
function AlertBadge({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-md bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900 dark:bg-amber-950 dark:text-amber-200">
      {children}
    </span>
  )
}

/// PROP-06's filing cabinet: cost basis, mortgages (with ARM/balloon
/// alerts), insurance (with renewal alert), HOA info, warranties. Same
/// per-subsection shape as OperationalDataSection: a list, then (if the
/// actor can write) a collapsed "Add" form.
export function FilingCabinetSection({
  propertyId,
  costBasisCents,
  mortgages,
  insurancePolicies,
  hoaInfo,
  warranties,
  canWrite,
}: {
  propertyId: string
  costBasisCents: number | null
  mortgages: Mortgage[]
  insurancePolicies: InsurancePolicy[]
  hoaInfo: HoaInfo | null
  warranties: Warranty[]
  canWrite: boolean
}) {
  const asOf = new Date()

  return (
    <section className="flex flex-col gap-6 rounded-md border p-4">
      <h2 className="text-sm font-semibold">Filing cabinet</h2>

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">Cost basis</h3>
        {canWrite ? (
          <CostBasisForm action={setCostBasis.bind(null, propertyId)} costBasisCents={costBasisCents} />
        ) : (
          <p className="text-sm">{dollars(costBasisCents)}</p>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">Mortgages</h3>
        {mortgages.length === 0 ? (
          <p className="text-muted-foreground text-sm">No mortgages on file.</p>
        ) : (
          <ul className="flex flex-col divide-y">
            {mortgages.map((mortgage) => (
              <li key={mortgage.id} className="flex flex-col gap-1 py-2 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    {mortgage.lender} — {mortgage.rateType}
                    {mortgage.currentBalanceCents != null &&
                      ` · ${dollars(mortgage.currentBalanceCents)} balance`}
                  </span>
                  {canWrite && (
                    <DeleteRowButton action={deleteMortgage.bind(null, propertyId, mortgage.id)} />
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  {mortgageArmAdjustmentDue(mortgage, asOf) && (
                    <AlertBadge>
                      ARM adjusts {mortgage.armAdjustmentDate && isoDate(mortgage.armAdjustmentDate)}
                    </AlertBadge>
                  )}
                  {mortgageBalloonMaturityDue(mortgage, asOf) && (
                    <AlertBadge>
                      Balloon matures {mortgage.maturityDate && isoDate(mortgage.maturityDate)}
                    </AlertBadge>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        {canWrite && (
          <details>
            <summary className="cursor-pointer text-sm font-medium">Add a mortgage</summary>
            <div className="pt-2">
              <AddMortgageForm action={addMortgage.bind(null, propertyId)} />
            </div>
          </details>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">Insurance</h3>
        {insurancePolicies.length === 0 ? (
          <p className="text-muted-foreground text-sm">No policies on file.</p>
        ) : (
          <ul className="flex flex-col divide-y">
            {insurancePolicies.map((policy) => (
              <li key={policy.id} className="flex flex-col gap-1 py-2 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    {policy.carrier} · renews {isoDate(policy.renewsOn)}
                    {policy.lossOfRents && ' · loss-of-rents'}
                  </span>
                  {canWrite && (
                    <DeleteRowButton
                      action={deleteInsurancePolicy.bind(null, propertyId, policy.id)}
                    />
                  )}
                </div>
                {insuranceRenewalDue(policy.renewsOn, asOf) && (
                  <AlertBadge>Renewal shopping window open</AlertBadge>
                )}
              </li>
            ))}
          </ul>
        )}
        {canWrite && (
          <details>
            <summary className="cursor-pointer text-sm font-medium">Add a policy</summary>
            <div className="pt-2">
              <AddInsurancePolicyForm action={addInsurancePolicy.bind(null, propertyId)} />
            </div>
          </details>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">HOA</h3>
        {hoaInfo ? (
          <p className="text-sm">
            {hoaInfo.name ?? 'On file'}
            {hoaInfo.hasRentalCap && ' · rental cap in effect'}
          </p>
        ) : (
          <p className="text-muted-foreground text-sm">No HOA on file.</p>
        )}
        {canWrite && (
          <details>
            <summary className="cursor-pointer text-sm font-medium">
              {hoaInfo ? 'Edit HOA info' : 'Add HOA info'}
            </summary>
            <div className="pt-2">
              <HoaInfoForm action={setHoaInfo.bind(null, propertyId)} hoaInfo={hoaInfo} />
            </div>
          </details>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">Warranties</h3>
        {warranties.length === 0 ? (
          <p className="text-muted-foreground text-sm">No warranties on file.</p>
        ) : (
          <ul className="flex flex-col divide-y">
            {warranties.map((warranty) => (
              <li key={warranty.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <span>
                  {WARRANTY_CATEGORY_LABELS[warranty.category] ?? warranty.category} —{' '}
                  {warranty.provider}
                  {warranty.expiresOn && ` · expires ${isoDate(warranty.expiresOn)}`}
                </span>
                {canWrite && (
                  <DeleteRowButton action={deleteWarranty.bind(null, propertyId, warranty.id)} />
                )}
              </li>
            ))}
          </ul>
        )}
        {canWrite && (
          <details>
            <summary className="cursor-pointer text-sm font-medium">Add a warranty</summary>
            <div className="pt-2">
              <AddWarrantyForm action={addWarranty.bind(null, propertyId)} />
            </div>
          </details>
        )}
      </div>
    </section>
  )
}
