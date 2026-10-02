import Link from 'next/link'

// UX-03: a detail route's position in the hierarchy, as a trail. The last
// item carries no href - it is where you are, not somewhere to go.

export function Breadcrumbs({
  items,
}: {
  items: readonly { label: string; href?: string }[]
}) {
  return (
    <nav aria-label="Breadcrumb" className="text-muted-foreground text-sm">
      <ol className="flex flex-wrap items-center gap-1">
        {items.map((item, index) => (
          <li key={index} className="flex items-center gap-1">
            {index > 0 && <span aria-hidden="true">/</span>}
            {item.href ? (
              <Link
                href={item.href}
                className="focus-visible:ring-ring rounded-md underline underline-offset-4 hover:text-foreground focus-visible:ring-2 focus-visible:outline-none"
              >
                {item.label}
              </Link>
            ) : (
              <span aria-current="page" className="text-foreground">
                {item.label}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  )
}
