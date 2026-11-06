import { formatRate } from "../../domain/speed.ts"
import { Icon } from "../Icon.tsx"

/** A compact drop-down of playback speeds. */
export const SpeedSelect = ({
  label,
  value,
  options,
  onChange,
  disabled,
  testId,
  title
}: {
  label: string
  value: number
  options: ReadonlyArray<number>
  onChange: (rate: number) => void
  disabled?: boolean
  testId: string
  title?: string
}) => {
  // A speed that isn't in the list (from an older version, say) still shows.
  const all = options.includes(value) ? options : [...options, value].sort((a, b) => a - b)
  return (
    <label className={`speedsel${disabled ? " off" : ""}`} title={title}>
      <span>{label}</span>
      <span className="selwrap">
        <select
          className="sel small"
          value={String(value)}
          disabled={disabled}
          onChange={(e) => onChange(Number(e.target.value))}
          data-testid={testId}
        >
          {all.map((r) => <option key={r} value={String(r)}>{formatRate(r)}</option>)}
        </select>
        <Icon name="chevron" />
      </span>
    </label>
  )
}
