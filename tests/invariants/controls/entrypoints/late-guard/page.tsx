import { prisma } from '@rental/db'
import { requireStaff } from '@/lib/auth/guard.ts'

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const properties = await prisma.property.findMany({ where: { id } })
  await requireStaff()
  return <p>{properties.length}</p>
}
