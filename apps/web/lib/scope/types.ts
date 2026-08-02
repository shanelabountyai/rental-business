// The shapes the property switcher needs, without the `server-only` import
// that current-scope.ts carries. A client component that imported that module
// would fail the build, and splitting the types is cheaper than passing six
// loose props through the shell.

export type ScopeSelection =
  | { kind: 'all' }
  | { kind: 'entity'; legalEntityId: string }
  | { kind: 'property'; propertyId: string }

export interface ResolvedScope {
  selection: ScopeSelection
  availableEntities: Array<{ id: string; name: string }>
  availableProperties: Array<{ id: string; name: string; legalEntityId: string }>
  propertyIds: string[]
  switchable: boolean
}
