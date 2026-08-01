// Reference data, not demo data - the rows that must exist in every
// environment for the app to function at all. Idempotent, so it is safe to
// re-run on every deploy.
//
// Empty until the items that own its contents land:
//   R-004  roles and permissions (roles-as-data, per D-5)
//   R-010  the seeded Texas JurisdictionRule and its effective-dated siblings
//   R-012  demo properties, units and tenants for e2e (separate script)

async function main() {
  console.info('Nothing to seed yet - see R-004 and R-010.')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
