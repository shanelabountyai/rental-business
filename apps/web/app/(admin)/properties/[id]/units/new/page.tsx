import { notFound } from 'next/navigation'
import { prisma } from '@rental/db'
import { PageHeader } from '@/components/page-header.tsx'
import { UnitForm } from '@/components/units/unit-form.tsx'
import { propertyResource, requirePermission } from '@/lib/auth/guard.ts'
import { createUnit } from '@/lib/units/actions.ts'

export const metadata = { title: 'New unit — Rental Operations' }

export default async function NewUnitPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params

  const property = await prisma.property.findUnique({ where: { id } })
  if (!property) notFound()
  await requirePermission('unit.write', propertyResource(property))

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={<>New unit at {property.name}</>} />
      <UnitForm
        action={createUnit.bind(null, id)}
        submitLabel="Create unit"
        defaults={{ status: 'VACANT' }}
      />
    </div>
  )
}
