'use client'

/**
 * The password-setup URL, shown to the owner who just minted it.
 *
 * `deliverAuthLink` drops every auth link in production (R-003's seam, never
 * rewired), so an invite that only emails the link is an invite that cannot
 * work on a deployment. This is the same posture `db:create-owner` already
 * takes by printing the link to a terminal - and the reader is the person who
 * created the account seconds ago and can mint another at will.
 *
 * ALWAYS MOUNTED, empty or not. It sits next to a live region for a reason:
 * a wrapper that appears along with its content is a new node rather than a
 * change, and assistive technology routinely says nothing about it.
 */
export function SetupLink({ url }: { url?: string }) {
  return (
    <div className="contents">
      {url && (
        <div className="flex flex-col gap-1 rounded-md border border-amber-300 bg-amber-50 px-3 py-2">
          <span className="text-sm font-medium text-amber-900">
            Setup link — send it to them yourself if the email does not arrive
          </span>
          <code className="text-xs break-all text-amber-950">{url}</code>
        </div>
      )}
    </div>
  )
}
