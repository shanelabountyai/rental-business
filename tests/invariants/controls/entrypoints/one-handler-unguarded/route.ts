import { requireStaff } from '@/lib/auth/guard.ts'

export async function GET() {
  await requireStaff()
  return new Response('ok')
}

export async function POST(request: Request) {
  const body = await request.json()
  await requireStaff()
  return Response.json(body)
}
