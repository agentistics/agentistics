import { AgentisticsLoader } from './AgentisticsLoader'

type CenteredLoaderProps = {
  label?: string
  size?: number
  testId?: string
  /**
   * `screen` (default): the loader stands for a whole screen that is still loading, so it sits in
   * the middle of the VIEWPORT on both axes, like the boot splash — a page container rarely has a
   * definite height, so centring inside it left the loader near the top. `area`: centred inside a
   * panel that does have a height (the chat panel).
   */
  placement?: 'screen' | 'area'
}

/** A loader for an area whose entire visible surface is waiting to render. */
export function CenteredLoader({ label, size = 56, testId = 'centered-loader', placement = 'screen' }: CenteredLoaderProps) {
  const centre = { display: 'flex', alignItems: 'center', justifyContent: 'center' } as const
  return (
    <div
      data-testid={testId}
      data-placement={placement}
      style={placement === 'screen'
        ? { ...centre, position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 5 }
        : { ...centre, flex: '1 1 auto', height: '100%', minHeight: 160, padding: 24, boxSizing: 'border-box' }}
    >
      <AgentisticsLoader size={size} label={label} />
    </div>
  )
}
