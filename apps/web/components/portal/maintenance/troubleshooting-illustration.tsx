// One small schematic diagram per troubleshooting step (MAINT-01: "a
// troubleshooting script WITH PICTURES").
//
// Inline SVG, not photography - this build has no photo library for real
// breaker panels or GFCI outlets, and a schematic that is honestly a diagram
// beats a stock photo that is honestly not this tenant's actual panel.
// `aria-hidden`: the instructions text (TroubleshootingStep.instructions)
// already fully describes the action in words, which is what §6.4's
// plain-language pass exists to guarantee works on its own - the picture is
// a supplementary aid for sighted tenants, not a second, competing source of
// the same information a screen reader would have to reconcile.
//
// ponytail: replace with real photography per unit once R-014's shutoff-photo
// pattern extends to general troubleshooting aids - the mechanism (an image
// next to the instructions) does not change, only the source of the image.

const STROKE = { fill: 'none', stroke: 'currentColor', strokeWidth: 4, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 120 120"
      aria-hidden="true"
      className="text-muted-foreground h-24 w-24 shrink-0"
    >
      {children}
    </svg>
  )
}

function Breaker() {
  return (
    <Frame>
      <rect x="20" y="15" width="80" height="90" rx="4" {...STROKE} />
      {[0, 1, 2, 3].map((row) => (
        <rect
          key={row}
          x="35"
          y={28 + row * 20}
          width="14"
          height="10"
          rx="2"
          fill={row === 2 ? 'currentColor' : 'none'}
          stroke="currentColor"
          strokeWidth={3}
        />
      ))}
      {[0, 1, 2, 3].map((row) => (
        <rect
          key={`b-${row}`}
          x="71"
          y={28 + row * 20}
          width="14"
          height="10"
          rx="2"
          {...STROKE}
        />
      ))}
    </Frame>
  )
}

function Gfci() {
  return (
    <Frame>
      <rect x="30" y="15" width="60" height="90" rx="6" {...STROKE} />
      <circle cx="48" cy="45" r="5" {...STROKE} />
      <circle cx="72" cy="45" r="5" {...STROKE} />
      <path d="M42 60 h36" {...STROKE} />
      <rect x="42" y="72" width="16" height="12" rx="2" {...STROKE} />
      <rect x="62" y="72" width="16" height="12" rx="2" fill="currentColor" />
      <text x="60" y="98" textAnchor="middle" fontSize="9" fill="currentColor">
        TEST · RESET
      </text>
    </Frame>
  )
}

function DisposalReset() {
  return (
    <Frame>
      <circle cx="60" cy="55" r="40" {...STROKE} />
      <circle cx="60" cy="55" r="8" fill="currentColor" />
      <circle cx="60" cy="55" r="3" fill="var(--background, white)" />
      <text x="60" y="105" textAnchor="middle" fontSize="9" fill="currentColor">
        reset button
      </text>
    </Frame>
  )
}

function ThermostatBattery() {
  return (
    <Frame>
      <circle cx="60" cy="52" r="35" {...STROKE} />
      <rect x="45" y="40" width="30" height="18" rx="2" {...STROKE} />
      <path d="M75 45 h4 v8 h-4" fill="currentColor" stroke="none" />
      <text x="60" y="100" textAnchor="middle" fontSize="9" fill="currentColor">
        battery
      </text>
    </Frame>
  )
}

function FurnaceSwitch() {
  return (
    <Frame>
      <rect x="42" y="15" width="36" height="60" rx="4" {...STROKE} />
      <rect x="52" y="24" width="16" height="26" rx="3" {...STROKE} />
      <text x="60" y="92" textAnchor="middle" fontSize="9" fill="currentColor">
        power switch
      </text>
    </Frame>
  )
}

function PilotLight() {
  return (
    <Frame>
      <rect x="25" y="20" width="70" height="60" rx="4" {...STROKE} />
      <circle cx="60" cy="50" r="16" {...STROKE} />
      <path d="M60 42 c4 6 4 10 0 14 c-4 -4 -4 -8 0 -14" fill="currentColor" stroke="none" />
      <text x="60" y="98" textAnchor="middle" fontSize="9" fill="currentColor">
        viewing window
      </text>
    </Frame>
  )
}

function Flapper() {
  return (
    <Frame>
      <rect x="30" y="15" width="60" height="55" rx="4" {...STROKE} />
      <path d="M40 55 q20 20 40 0" {...STROKE} />
      <circle cx="60" cy="40" r="4" fill="currentColor" />
      <text x="60" y="90" textAnchor="middle" fontSize="9" fill="currentColor">
        flapper
      </text>
    </Frame>
  )
}

const ILLUSTRATIONS: Record<string, () => React.JSX.Element> = {
  breaker: Breaker,
  gfci: Gfci,
  disposal_reset: DisposalReset,
  thermostat_battery: ThermostatBattery,
  furnace_switch: FurnaceSwitch,
  pilot_light: PilotLight,
  flapper: Flapper,
}

export function TroubleshootingIllustration({ stepId }: { stepId: string }) {
  const Illustration = ILLUSTRATIONS[stepId]
  if (!Illustration) return null
  return <Illustration />
}
