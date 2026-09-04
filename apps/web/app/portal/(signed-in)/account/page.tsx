import Link from "next/link";
import { friendlyTimestamp } from "@rental/core/scheduling";
import { prisma } from "@rental/db";
import { NotificationPreferencesSection } from "@/components/notifications/preferences-section.tsx";
import { TenantConsentSection } from "@/components/portal/tenant-consent-section.tsx";
import { withdrawOwnConsent } from "@/lib/consent/actions.ts";
import { consentsForTenant } from "@/lib/consent/queries.ts";
import { setOwnNotificationPreference } from "@/lib/notifications/actions.ts";
import { getPreferences } from "@/lib/notifications/queries.ts";
import { requireTenant } from "@/lib/portal/guard.ts";

export const metadata = { title: "Your account" };

// R-164: the tenant's own say over how they are contacted and billed.
//
// Autopay itself lives on /portal/pay, not here - it is one control with two
// states (on/off) and a debit-day picker underneath, and splitting that
// across two pages would mean two places reading the same LeasePayer and two
// places that could disagree about which is current. This page links to it
// rather than duplicating it.
//
// No timezone on record for a tenant the way a property has one (R-115's
// fix elsewhere reads the PROPERTY's zone) - a tenant can hold leases at more
// than one property, so consent timestamps here read in the FIRST lease's
// property zone, same fallback /account (staff) uses for on-call.

export default async function TenantAccountPage() {
  const tenant = await requireTenant();

  const [preferences, consents, zone] = await Promise.all([
    getPreferences("TENANT", tenant.id),
    consentsForTenant(tenant.id),
    firstLeasePropertyZone(tenant.id),
  ]);

  return (
    <div className="flex w-full flex-col gap-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">Your account</h1>
        <p className="text-muted-foreground text-base">
          {tenant.name}
          {tenant.email ? ` · ${tenant.email}` : ""}
        </p>
      </header>

      <section className="flex flex-col gap-2 rounded-lg border p-4">
        <h2 className="text-base font-medium">Automatic payments</h2>
        <p className="text-base">
          Turn automatic payments on or off, and choose which day rent is
          collected, from{" "}
          <Link
            href="/portal/pay"
            className="focus-visible:ring-ring underline underline-offset-4 focus-visible:ring-2 focus-visible:outline-none"
          >
            Pay rent
          </Link>
          .
        </p>
      </section>

      <NotificationPreferencesSection
        preferences={preferences}
        action={setOwnNotificationPreference}
      />

      <TenantConsentSection
        consents={consents.map((row) => ({
          id: row.id,
          channel: row.channel,
          basis: row.basis,
          recordedOn: friendlyTimestamp(row.recordedAt, zone),
          revokedOn: row.revokedAt ? friendlyTimestamp(row.revokedAt, zone) : null,
          revokeReason: row.revokeReason,
        }))}
        withdrawAction={withdrawOwnConsent}
      />
    </div>
  );
}

async function firstLeasePropertyZone(tenantId: string) {
  const leaseTenant = await prisma.leaseTenant.findFirst({
    where: { tenantId },
    orderBy: { createdAt: "asc" },
    select: { lease: { select: { property: { select: { timezone: true } } } } },
  });
  return leaseTenant?.lease.property.timezone ?? "UTC";
}
