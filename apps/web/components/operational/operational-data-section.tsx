import { friendlyTimestamp } from '@rental/core/scheduling'
import type { AccessCode, Appliance, ShutoffLocation, UtilityAccount } from '@rental/db'
import { AddAccessCodeForm } from '@/components/operational/add-access-code-form.tsx'
import { AddApplianceForm } from '@/components/operational/add-appliance-form.tsx'
import { AddUtilityAccountForm } from '@/components/operational/add-utility-account-form.tsx'
import { DeleteRowButton } from '@/components/operational/delete-row-button.tsx'
import { RevealCodeButton } from '@/components/operational/reveal-code-button.tsx'
import { ShutoffLocationForm } from '@/components/operational/shutoff-location-form.tsx'
import {
  addAccessCode,
  addAppliance,
  addUtilityAccount,
  deleteAppliance,
  deleteUtilityAccount,
  revealAccessCode,
  setShutoffLocation,
} from '@/lib/operational/actions.ts'

const ACCESS_CODE_TYPE_LABELS: Record<string, string> = {
  LOCKBOX: 'Lockbox',
  SMART_LOCK: 'Smart lock',
  GATE: 'Gate',
  MAILBOX: 'Mailbox',
  OTHER: 'Other',
}
const APPLIANCE_CATEGORY_LABELS: Record<string, string> = {
  REFRIGERATOR: 'Refrigerator',
  RANGE: 'Range',
  DISHWASHER: 'Dishwasher',
  WASHER: 'Washer',
  DRYER: 'Dryer',
  WATER_HEATER: 'Water heater',
  HVAC: 'HVAC',
  MICROWAVE: 'Microwave',
  OTHER: 'Other',
}
const UTILITY_TYPE_LABELS: Record<string, string> = {
  ELECTRIC: 'Electric',
  GAS: 'Gas',
  WATER: 'Water',
  SEWER: 'Sewer',
  TRASH: 'Trash',
  OTHER: 'Other',
}
const SHUTOFF_TYPE_LABELS: Record<string, string> = {
  WATER_MAIN: 'Water main',
  BREAKER_PANEL: 'Breaker panel',
  GAS: 'Gas',
  OTHER: 'Other',
}

/// PROP-03's four kinds of unit operational data, one subsection each. Every
/// subsection follows the same shape: a list, then (if the actor can write)
/// a collapsed "Add" form - a plain <details>, the same progressive-
/// disclosure pattern R-012's "Recently deleted" list already established,
/// so four forms do not turn this into a wall of always-visible inputs.
export async function OperationalDataSection({
  unitId,
  accessCodes,
  accessCodeHistories,
  timeZone,
  appliances,
  utilityAccounts,
  shutoffs,
  canWrite,
  canReveal,
}: {
  unitId: string
  accessCodes: AccessCode[]
  /// Every version ever recorded per code slot (R-148, PROP-03's history
  /// log). Metadata only - the sealed code never renders here; revealing a
  /// current code stays behind `canReveal` and its audit row.
  accessCodeHistories: Record<string, AccessCode[]>
  /// The property's clock, for the history dates.
  timeZone: string
  appliances: Appliance[]
  utilityAccounts: UtilityAccount[]
  shutoffs: ShutoffLocation[]
  canWrite: boolean
  canReveal: boolean
}) {
  return (
    <section className="flex flex-col gap-6 rounded-md border p-4">
      <h2 className="text-sm font-semibold">Operational data</h2>

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">Access codes</h3>
        {accessCodes.length === 0 ? (
          <p className="text-muted-foreground text-sm">No codes on file.</p>
        ) : (
          <ul className="flex flex-col divide-y">
            {accessCodes.map((code) => (
              <li key={code.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <span>
                  {ACCESS_CODE_TYPE_LABELS[code.type] ?? code.type}
                  {code.label ? ` — ${code.label}` : ''}
                </span>
                {canReveal ? (
                  <RevealCodeButton action={revealAccessCode.bind(null, unitId, code.id, null)} />
                ) : (
                  <span className="text-muted-foreground font-mono text-sm">••••</span>
                )}
                {(accessCodeHistories[code.type]?.length ?? 0) > 0 && (
                  <details className="w-full">
                    <summary className="min-h-11 cursor-pointer text-sm">
                      History ({accessCodeHistories[code.type]!.length}{' '}
                      {accessCodeHistories[code.type]!.length === 1 ? 'version' : 'versions'})
                    </summary>
                    <ul className="text-muted-foreground flex flex-col gap-1 pt-1 pl-4">
                      {accessCodeHistories[code.type]!.map((version) => (
                        <li key={version.id}>
                          v{version.version}
                          {version.label ? ` — ${version.label}` : ''} · set{' '}
                          {friendlyTimestamp(version.effectiveFrom, timeZone)}
                          {version.effectiveTo
                            ? ` · replaced ${friendlyTimestamp(version.effectiveTo, timeZone)}`
                            : ' · current'}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </li>
            ))}
          </ul>
        )}
        {canWrite && (
          <details>
            <summary className="min-h-11 cursor-pointer text-sm font-medium">
              Add or replace a code
            </summary>
            <div className="pt-2">
              <AddAccessCodeForm action={addAccessCode.bind(null, unitId)} />
            </div>
          </details>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">Appliances</h3>
        {appliances.length === 0 ? (
          <p className="text-muted-foreground text-sm">No appliances on file.</p>
        ) : (
          <ul className="flex flex-col divide-y">
            {appliances.map((appliance) => (
              <li key={appliance.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <span>
                  {APPLIANCE_CATEGORY_LABELS[appliance.category] ?? appliance.category}
                  {appliance.make || appliance.model
                    ? ` — ${[appliance.make, appliance.model].filter(Boolean).join(' ')}`
                    : ''}
                  {appliance.category === 'HVAC' && appliance.filterSize
                    ? ` · filter ${appliance.filterSize}`
                    : ''}
                </span>
                {canWrite && (
                  <DeleteRowButton action={deleteAppliance.bind(null, unitId, appliance.id)} />
                )}
              </li>
            ))}
          </ul>
        )}
        {canWrite && (
          <details>
            <summary className="min-h-11 cursor-pointer text-sm font-medium">Add an appliance</summary>
            <div className="pt-2">
              <AddApplianceForm action={addAppliance.bind(null, unitId)} />
            </div>
          </details>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">Utility accounts</h3>
        {utilityAccounts.length === 0 ? (
          <p className="text-muted-foreground text-sm">No utility accounts on file.</p>
        ) : (
          <ul className="flex flex-col divide-y">
            {utilityAccounts.map((account) => (
              <li key={account.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <span>
                  {UTILITY_TYPE_LABELS[account.type] ?? account.type} — {account.provider}
                  {!account.landlordRevertAgreement && ' · no revert agreement on file'}
                </span>
                {canWrite && (
                  <DeleteRowButton action={deleteUtilityAccount.bind(null, unitId, account.id)} />
                )}
              </li>
            ))}
          </ul>
        )}
        {canWrite && (
          <details>
            <summary className="min-h-11 cursor-pointer text-sm font-medium">Add a utility account</summary>
            <div className="pt-2">
              <AddUtilityAccountForm action={addUtilityAccount.bind(null, unitId)} />
            </div>
          </details>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">Shutoff locations</h3>
        {shutoffs.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            Nothing on file yet - water main, breaker panel and gas shutoffs matter
            most in an active-leak or emergency call.
          </p>
        ) : (
          <ul className="flex flex-col divide-y">
            {shutoffs.map((shutoff) => (
              <li key={shutoff.id} className="flex flex-col gap-0.5 py-2 text-sm">
                <span className="font-medium">
                  {SHUTOFF_TYPE_LABELS[shutoff.type] ?? shutoff.type}
                </span>
                <span className="text-muted-foreground">{shutoff.description}</span>
              </li>
            ))}
          </ul>
        )}
        {canWrite && (
          <details>
            <summary className="min-h-11 cursor-pointer text-sm font-medium">
              Set a shutoff location
            </summary>
            <div className="pt-2">
              <ShutoffLocationForm action={setShutoffLocation.bind(null, unitId)} />
            </div>
          </details>
        )}
        <p className="text-muted-foreground text-xs">
          Attach a photo under Documents below, type &ldquo;Shutoff photo&rdquo;.
        </p>
      </div>
    </section>
  )
}
