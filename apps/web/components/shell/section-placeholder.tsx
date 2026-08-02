// A section the shell can navigate to but that its owning item has not built
// yet. Names that item, so a half-built product explains itself rather than
// looking broken - and so nobody wires a second version of it by accident.

export function SectionPlaceholder({
  title,
  ownedBy,
  description,
  scopeSummary,
}: {
  title: string
  ownedBy: string
  description: string
  scopeSummary?: string
}) {
  return (
    <div className="flex flex-col gap-3">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="text-muted-foreground max-w-prose text-sm">{description}</p>
      {scopeSummary && (
        <p className="text-muted-foreground text-sm">{scopeSummary}</p>
      )}
      <p className="text-muted-foreground text-sm">
        Built by <code className="font-mono">{ownedBy}</code>.
      </p>
    </div>
  )
}
