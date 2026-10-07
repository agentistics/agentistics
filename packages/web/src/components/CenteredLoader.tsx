import { AgentisticsLoader } from './AgentisticsLoader'

type CenteredLoaderProps = {
  label?: string
  size?: number
  testId?: string
}

/** A loader for an area whose entire visible surface is waiting to render. */
export function CenteredLoader({ label, size = 56, testId = 'centered-loader' }: CenteredLoaderProps) {
  return (
    <div
      data-testid={testId}
      style={{
        flex: '1 1 auto',
        minHeight: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 40,
        boxSizing: 'border-box',
      }}
    >
      <AgentisticsLoader size={size} label={label} />
    </div>
  )
}
