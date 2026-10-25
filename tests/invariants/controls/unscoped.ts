'use server'

// Manifest control: every shape of a missing or wrong tag, in export order.
export async function badModel(leaseId: string) {
  return leaseId
}

export async function tagged(leaseId: string, _previous: unknown, formData: FormData) {
  return [leaseId, formData.getAll('vendorIds')]
}

export async function untagged(workOrderId: string) {
  return workOrderId
}

const str = (formData: FormData, key: string) => String(formData.get(key) ?? '')

export async function missing(_previous: unknown, formData: FormData) {
  return [formData.get('ticketId'), str(formData, 'unitId')]
}
