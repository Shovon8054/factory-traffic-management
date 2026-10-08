import { useEffect, useState } from 'react'
import './App.css'
import './signals.css'
import { useTrafficDashboard } from './useTrafficDashboard'

type Direction = 'NORTH' | 'SOUTH' | 'EAST' | 'WEST'
type Phase = 'NORTH_SOUTH' | 'EAST_WEST'
type VehicleType = 'CAR' | 'MOTORCYCLE' | 'BUS' | 'TRUCK' | 'FORKLIFT' | 'EMERGENCY' | 'EMPLOYEE_VEHICLE'
type EventType = 'ARRIVED' | 'CLEARED'

const directions: Direction[] = ['NORTH', 'EAST', 'SOUTH', 'WEST']
const vehicleTypes: VehicleType[] = ['CAR', 'MOTORCYCLE', 'BUS', 'TRUCK', 'FORKLIFT', 'EMERGENCY', 'EMPLOYEE_VEHICLE']

function formatTime(value?: string | number | Date | null) {
  if (!value) return 'Time unavailable'
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? 'Time unavailable'
    : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function App() {
  const dashboard = useTrafficDashboard()
  const [phase, setPhase] = useState<Phase>('NORTH_SOUTH')
  const [manualDirection, setManualDirection] = useState<Direction>('NORTH')
  const [simulation, setSimulation] = useState({
    direction: 'NORTH' as Direction,
    vehicleType: 'CAR' as VehicleType,
    eventType: 'ARRIVED' as EventType,
    vehicleId: '',
  })
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState('')
  const [notice, setNotice] = useState('')

  const selected = dashboard.status
  const state = selected?.state
  const junction = selected?.junction
  const actualSignals = state?.actual?.signals
  const isDegraded = state?.mode === 'DEGRADED' || junction?.controller_status === 'DEGRADED'
  const isOffline = junction?.controller_status === 'OFFLINE'
  const isRecovering = junction?.controller_status === 'RECOVERING'
  const emergencyActive = state?.mode === 'EMERGENCY'
  const isManualActive = state?.mode === 'MANUAL'
  const isUnknownState = state?.actual?.step === 'UNKNOWN'
  const hasMismatch =
    state?.desired &&
    state?.actual &&
    state.desired.step !== 'ALL_RED' &&
    state.actual.step !== 'UNKNOWN' &&
    state.actual.step !== state.desired.step

  useEffect(() => {
    if (state?.desired?.phase) setPhase(state.desired.phase)
  }, [state?.desired?.phase])

  async function submitCommand(type: 'MANUAL_MODE_REQUEST' | 'EMERGENCY_REQUEST' | 'RETURN_TO_AUTOMATIC', dir?: Direction) {
    if (!dashboard.selectedId) return
    setBusy(true)
    setActionError('')
    setNotice('')
    try {
      if (type === 'RETURN_TO_AUTOMATIC') {
        await dashboard.postRaw(`/junctions/${encodeURIComponent(dashboard.selectedId)}/commands`, {
          command: 'RETURN_TO_AUTOMATIC',
        })
        setNotice('Returned to automatic mode')
      } else if (type === 'MANUAL_MODE_REQUEST') {
        const targetDir = dir ?? manualDirection
        await dashboard.postRaw(`/junctions/${encodeURIComponent(dashboard.selectedId)}/commands`, {
          command: 'MANUAL_GREEN_REQUEST',
          direction: targetDir,
        })
        setNotice(`Manual green requested for direction ${targetDir}`)
      } else if (type === 'EMERGENCY_REQUEST') {
        await dashboard.postCommand({
          type: 'EMERGENCY_REQUEST',
          junctionId: dashboard.selectedId,
          emergencyId: `web-${crypto.randomUUID()}`,
          phase,
          occurredAt: Date.now(),
        })
        setNotice('Emergency priority request sent')
      }
      await dashboard.refresh()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Command could not be sent')
    } finally {
      setBusy(false)
    }
  }

  async function sendBadCommand() {
    setBusy(true)
    setActionError('')
    setNotice('')
    try {
      await dashboard.postRaw(`/junctions/${encodeURIComponent(dashboard.selectedId || 'A')}/commands`, {
        command: 'INVALID_COMMAND_NAME',
      })
      setNotice('Unexpected success for invalid command')
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Bad command rejected')
    } finally {
      setBusy(false)
    }
  }

  async function setControllerStatus(status: 'OFFLINE' | 'ONLINE') {
    if (!dashboard.selectedId) return
    setBusy(true)
    setActionError('')
    setNotice('')
    try {
      await dashboard.postControllerEvent({
        junctionId: dashboard.selectedId,
        status,
      })
      setNotice(`Controller status set to ${status}`)
      await dashboard.refresh()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : `Failed to set controller status ${status}`)
    } finally {
      setBusy(false)
    }
  }

  async function ackPendingCommand() {
    if (!dashboard.selectedId || !dashboard.pendingCommand) return
    setBusy(true)
    setActionError('')
    setNotice('')
    try {
      await dashboard.postControllerEvent({
        commandId: dashboard.pendingCommand.command_id,
        junctionId: dashboard.selectedId,
        status: 'ACKNOWLEDGED',
        actualState: dashboard.pendingCommand.requested_state ?? 'GREEN',
      })
      setNotice(`Acknowledged command ${dashboard.pendingCommand.command_id.slice(0, 8)}...`)
      await dashboard.refresh()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Failed to acknowledge command')
    } finally {
      setBusy(false)
    }
  }

  async function submitSimulation(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!dashboard.selectedId) return
    setBusy(true)
    setActionError('')
    setNotice('')
    try {
      await dashboard.postSensorEvent({
        eventId: `sim-${crypto.randomUUID()}`,
        junctionId: dashboard.selectedId,
        direction: simulation.direction,
        eventType: simulation.eventType,
        vehicleId: simulation.vehicleId.trim() || `vehicle-${crypto.randomUUID().slice(0, 8)}`,
        vehicleType: simulation.vehicleType,
        sensorTimestamp: new Date().toISOString(),
      })
      setNotice(`Sensor event ${simulation.eventType} recorded for ${simulation.direction}`)
      setSimulation((current) => ({ ...current, vehicleId: '' }))
      await dashboard.refresh()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Simulation event failed')
    } finally {
      setBusy(false)
    }
  }

  const activity = dashboard.history
    .filter((item) => !item.event_type?.toUpperCase().startsWith('TICK'))
    .slice(0, 8)
  const totalQueued = selected?.queues?.reduce((sum, item) => sum + item.queue_count, 0) ?? 0

  return (
    <main className="app-shell">
      <aside className="rail">
        <div className="brand-mark" aria-label="Factory traffic">FT</div>
        <div className="rail-rule" />
        <button className="rail-button selected" aria-label="Operations overview" title="Operations overview">▦</button>
        <button className="rail-button" aria-label="Junction controls" title="Junction controls" onClick={() => document.getElementById('control-panel')?.scrollIntoView({ behavior: 'smooth' })}>⌘</button>
        <button className="rail-button" aria-label="Activity history" title="Activity history" onClick={() => document.getElementById('activity-panel')?.scrollIntoView({ behavior: 'smooth' })}>≡</button>
        <div className="rail-spacer" />
        <span className={`rail-status ${dashboard.connected ? 'online' : 'polling'}`} title={dashboard.connected ? 'Live connection' : 'Polling fallback'} />
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div className="topbar-brand">
            <span className="brand-square">F</span>
            <span>FACTORY TRAFFIC</span>
            <span className="topbar-divider">/</span>
            <span className="muted">CONTROL ROOM</span>
          </div>
          <div className="topbar-right">
            <span className={`connection-pill ${dashboard.connected ? 'connected' : ''}`}>
              <i />
              {dashboard.connected ? 'LIVE STREAM' : 'POLLING'}
            </span>
            <time>{new Date().toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}</time>
          </div>
        </header>

        <div className="page-content">
          <div className="page-heading">
            <div>
              <p className="eyebrow">TRAFFIC OPERATIONS <span>•</span> SHIFT MONITOR</p>
              <h1>Junction overview</h1>
              <p className="subheading">Live signal state, demand, and controller activity.</p>
            </div>
            <button className="refresh-button" onClick={() => void dashboard.refresh()} disabled={dashboard.loading} title="Refresh data">
              <span className={dashboard.loading ? 'refresh-glyph spinning' : 'refresh-glyph'}>↻</span>
              <span>Refresh</span>
            </button>
          </div>

          {/* Emergency Banner: shows junction, direction/phase, mode and current step */}
          {emergencyActive && (
            <div className="emergency-banner" role="alert" id="emergency-banner">
              <span className="emergency-symbol">!</span>
              <div>
                <strong>Emergency Priority Active</strong>
                <p style={{ margin: '2px 0 0', fontSize: '11px', opacity: 0.9 }}>
                  Junction: <strong>{junction?.id ?? '—'} ({junction?.name ?? 'Unknown'})</strong> • Direction/Phase: <strong>{state?.pendingPhase ?? state?.actual?.phase ?? '—'}</strong> • Mode: <strong>{state?.mode ?? 'EMERGENCY'}</strong> • Step: <strong>{state?.actual?.step ?? 'UNKNOWN'}</strong>
                </p>
              </div>
              <span className="banner-pulse" />
            </div>
          )}

          {/* Failure Warnings */}
          {isOffline && (
            <div className="alert-banner danger" role="alert" id="alert-controller-offline">
              <strong>Controller Offline Warning</strong>
              <span>Controller communication is lost for junction {junction?.id ?? '—'}. Signals are held at safe fallback state.</span>
            </div>
          )}
          {isDegraded && !isOffline && (
            <div className="alert-banner danger" role="alert" id="alert-controller-degraded">
              <strong>Controller Degraded Warning</strong>
              <span>ACK retries exhausted or hardware communication timed out. Signals are held at safe fallback (ALL RED).</span>
            </div>
          )}
          {isRecovering && (
            <div className="alert-banner warning" role="alert" id="alert-recovering">
              <strong>Startup Recovery in Progress</strong>
              <span>Controller state is unconfirmed; waiting for controller handshake.</span>
            </div>
          )}
          {isUnknownState && !isDegraded && (
            <div className="alert-banner warning" role="alert" id="alert-unknown-state">
              <strong>Signals in UNKNOWN State Warning</strong>
              <span>Actual signal lamps have not been confirmed by controller hardware. Displaying grey unconfirmed state.</span>
            </div>
          )}
          {hasMismatch && (
            <div className="alert-banner warning" role="alert" id="alert-state-mismatch">
              <strong>Desired / Actual Mismatch Warning</strong>
              <span>Desired state is {state?.desired?.step} ({state?.desired?.phase}), but controller actual state is {state?.actual?.step} ({state?.actual?.phase}).</span>
            </div>
          )}

          {/* Error and Notice Banners */}
          {dashboard.error && (
            <div className="alert-banner danger" role="alert" id="dashboard-error-banner">
              <strong>Data Connection Issue</strong>
              <span>{dashboard.error}</span>
              <button onClick={() => void dashboard.refresh()}>Retry</button>
            </div>
          )}
          {actionError && (
            <div className="alert-banner danger" role="alert" id="action-error-banner">
              <strong>Action Failed</strong>
              <span>{actionError}</span>
              <button onClick={() => setActionError('')} aria-label="Dismiss action error">Dismiss</button>
            </div>
          )}
          {notice && (
            <div className="inline-notice" role="status" id="notice-banner">
              {notice}
              <button onClick={() => setNotice('')} aria-label="Dismiss notice">×</button>
            </div>
          )}

          {/* Overview Strip */}
          <section className="overview-strip" aria-label="Overview metrics">
            <div className="metric">
              <span>JUNCTIONS</span>
              <strong>{dashboard.junctions.length.toString().padStart(2, '0')}</strong>
              <small>registered</small>
            </div>
            <div className="metric">
              <span>SELECTED</span>
              <strong>{junction?.id ?? '—'}</strong>
              <small>{junction?.name ?? 'No junction selected'}</small>
            </div>
            <div className="metric">
              <span>MODE</span>
              <strong className={emergencyActive ? 'text-red' : isManualActive ? 'text-amber' : ''}>{state?.mode ?? '—'}</strong>
              <small>{isManualActive ? 'Manual active' : junction?.controller_status ?? 'Awaiting status'}</small>
            </div>
            <div className="metric">
              <span>VEHICLES QUEUED</span>
              <strong>{totalQueued.toString().padStart(2, '0')}</strong>
              <small>across approaches</small>
            </div>
            <div className="metric metric-updated">
              <span>LAST UPDATED</span>
              <strong>{formatTime(dashboard.lastUpdated)}</strong>
              <small>{dashboard.connected ? 'Socket.IO live stream' : 'Polling every 5 seconds'}</small>
            </div>
          </section>

          <div className="main-grid">
            {/* Junction Network Panel */}
            <section className="panel junction-panel">
              <div className="panel-heading">
                <div>
                  <p className="eyebrow">NETWORK</p>
                  <h2>Junctions <span className="count-tag">{dashboard.junctions.length}</span></h2>
                </div>
                <span className="panel-mark">01</span>
              </div>
              {dashboard.junctions.length === 0 ? (
                <div className="empty-state">{dashboard.loading ? 'Loading junctions…' : 'No junctions available'}</div>
              ) : (
                <div className="junction-list">
                  {dashboard.junctions.map((item) => {
                    const active = item.id === dashboard.selectedId
                    const health = item.controller_status?.toUpperCase() ?? 'UNKNOWN'
                    return (
                      <button className={`junction-row ${active ? 'active' : ''}`} key={item.id} onClick={() => dashboard.selectJunction(item.id)}>
                        <span className="junction-initial">{item.id.slice(0, 1)}</span>
                        <span className="junction-copy">
                          <strong>{item.name}</strong>
                          <small>{item.id} <span>·</span> {item.current_phase?.replace('_', ' ')}</small>
                        </span>
                        <span className={`health-dot ${health === 'ONLINE' ? 'healthy' : health === 'RECOVERING' ? 'caution' : 'unhealthy'}`} title={health} />
                      </button>
                    )
                  })}
                </div>
              )}
            </section>

            {/* Intersection Visual & Detail Panel */}
            <section className="panel intersection-panel">
              <div className="panel-heading">
                <div>
                  <p className="eyebrow">SELECTED JUNCTION <span>·</span> {junction?.id ?? '—'}</p>
                  <h2>{junction?.name ?? 'Intersection state'}</h2>
                </div>
                <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                  {isManualActive && <span className="mode-badge manual" style={{ background: '#f59e0b', color: '#000' }}>MANUAL ACTIVE</span>}
                  <span className={`mode-badge ${isDegraded ? 'bad' : emergencyActive ? 'emergency' : ''}`}>{state?.mode ?? 'UNKNOWN'}</span>
                </div>
              </div>

              {/* Intersection Visual: ALL FOUR LAMPS visible with correct actual colors & desired ring */}
              <div className="intersection-wrap" aria-label="Backend-reported intersection signal state">
                <div className="road-label north">
                  <span>N</span>
                  <small>{selected?.queues?.find((q) => q.direction === 'NORTH')?.queue_count ?? state?.queueCounts?.NORTH ?? 0} wait</small>
                </div>
                <div className="signal-stack north-signal" aria-label={`North actual ${actualSignals?.NORTH ?? 'UNKNOWN'}, desired ${state?.desired?.signals?.NORTH ?? 'UNKNOWN'}`}>
                  <SignalLight actual={actualSignals?.NORTH} desired={state?.desired?.signals?.NORTH} />
                </div>

                <div className="road-label west">
                  <span>W</span>
                  <small>{selected?.queues?.find((q) => q.direction === 'WEST')?.queue_count ?? state?.queueCounts?.WEST ?? 0}</small>
                </div>
                <div className="signal-stack west-signal" aria-label={`West actual ${actualSignals?.WEST ?? 'UNKNOWN'}, desired ${state?.desired?.signals?.WEST ?? 'UNKNOWN'}`}>
                  <SignalLight actual={actualSignals?.WEST} desired={state?.desired?.signals?.WEST} />
                </div>

                <div className="signal-stack east-signal" aria-label={`East actual ${actualSignals?.EAST ?? 'UNKNOWN'}, desired ${state?.desired?.signals?.EAST ?? 'UNKNOWN'}`}>
                  <SignalLight actual={actualSignals?.EAST} desired={state?.desired?.signals?.EAST} />
                </div>
                <div className="road-label east">
                  <span>E</span>
                  <small>{selected?.queues?.find((q) => q.direction === 'EAST')?.queue_count ?? state?.queueCounts?.EAST ?? 0}</small>
                </div>

                <div className="signal-stack south-signal" aria-label={`South actual ${actualSignals?.SOUTH ?? 'UNKNOWN'}, desired ${state?.desired?.signals?.SOUTH ?? 'UNKNOWN'}`}>
                  <SignalLight actual={actualSignals?.SOUTH} desired={state?.desired?.signals?.SOUTH} />
                </div>
                <div className="road-label south">
                  <span>S</span>
                  <small>{selected?.queues?.find((q) => q.direction === 'SOUTH')?.queue_count ?? state?.queueCounts?.SOUTH ?? 0} wait</small>
                </div>
              </div>

              {/* Actual vs Desired Readout */}
              <div className="intersection-readout" aria-label="Controller-confirmed actual state">
                <span>ACTUAL CONFIRMED</span>
                <strong>{state?.actual?.step ?? 'UNKNOWN'}</strong>
                <small>{state?.actual?.phase?.replace('_', ' ') ?? 'NOT CONFIRMED'}</small>
              </div>
              <div className="desired-state">
                <span>DESIRED TARGET</span>
                <strong>{state?.desired?.step ?? 'UNKNOWN'}</strong>
                <small>{state?.desired?.phase?.replace('_', ' ') ?? 'No state reported'}</small>
                <span className="desired-mark">→</span>
              </div>

              <div className="state-legend">
                <span><i className="legend-dot red" />ACTUAL RED</span>
                <span><i className="legend-dot yellow" />ACTUAL YELLOW</span>
                <span><i className="legend-dot green" />ACTUAL GREEN</span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                  <i style={{ width: '8px', height: '8px', borderRadius: '50%', border: '1px dashed #fff', display: 'inline-block' }} />
                  DESIRED RING
                </span>
                <span className="legend-note">Grey only for UNKNOWN</span>
              </div>

              {/* Pending Controller Command with command_id */}
              <div style={{ margin: '10px 16px', padding: '10px', background: '#1e293b', borderRadius: '8px', border: '1px solid #334155', color: '#cbd5e1', fontSize: '11px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                  <span style={{ fontWeight: 700, color: '#94a3b8', letterSpacing: '0.05em' }}>PENDING CONTROLLER COMMAND</span>
                  {dashboard.pendingCommand ? (
                    <span style={{ background: '#f59e0b', color: '#000', padding: '2px 6px', borderRadius: '4px', fontWeight: 700, fontSize: '10px' }}>PENDING ACK</span>
                  ) : (
                    <span style={{ color: '#10b981', fontWeight: 600 }}>NONE PENDING</span>
                  )}
                </div>
                {dashboard.pendingCommand ? (
                  <div>
                    <div style={{ wordBreak: 'break-all', fontFamily: 'monospace', color: '#67e8f9', margin: '4px 0' }}>
                      ID: {dashboard.pendingCommand.command_id}
                    </div>
                    <div style={{ display: 'flex', gap: '12px', color: '#94a3b8' }}>
                      <span>Direction: <strong style={{ color: '#fff' }}>{dashboard.pendingCommand.direction ?? '—'}</strong></span>
                      <span>Target State: <strong style={{ color: '#fff' }}>{dashboard.pendingCommand.requested_state ?? '—'}</strong></span>
                    </div>
                  </div>
                ) : (
                  <div style={{ color: '#64748b' }}>All hardware commands are confirmed and synchronized.</div>
                )}
              </div>
            </section>

            {/* Operator Actions & Manual Control Panel */}
            <section className="panel controls-panel" id="control-panel">
              <div className="panel-heading">
                <div>
                  <p className="eyebrow">OPERATOR ACTIONS</p>
                  <h2>Manual & override control</h2>
                </div>
                <span className="panel-mark">02</span>
              </div>

              {isManualActive && (
                <div style={{ padding: '8px 12px', background: '#78350f', border: '1px solid #f59e0b', borderRadius: '6px', color: '#fef3c7', fontSize: '12px', fontWeight: 600, marginBottom: '12px' }}>
                  ◉ Manual Mode Active on {junction?.id ?? '—'}
                </div>
              )}

              <label className="field-label" htmlFor="manual-dir-select">REQUEST MANUAL GREEN FOR DIRECTION</label>
              <div className="phase-select" role="group" aria-label="Manual direction request" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '6px', marginBottom: '12px' }}>
                {directions.map((dir) => (
                  <button
                    type="button"
                    key={dir}
                    className={manualDirection === dir ? 'chosen' : ''}
                    onClick={() => {
                      setManualDirection(dir)
                      void submitCommand('MANUAL_MODE_REQUEST', dir)
                    }}
                    disabled={busy || !dashboard.selectedId}
                    title={`Request manual green for ${dir}`}
                  >
                    {dir}
                  </button>
                ))}
              </div>

              <div className="control-actions">
                <button
                  className="quiet-action"
                  disabled={busy || !dashboard.selectedId}
                  onClick={() => void submitCommand('RETURN_TO_AUTOMATIC')}
                  style={{ width: '100%', marginBottom: '6px' }}
                >
                  Return to automatic
                </button>
                <button
                  className="emergency-action"
                  disabled={busy || !dashboard.selectedId}
                  onClick={() => void submitCommand('EMERGENCY_REQUEST')}
                  style={{ width: '100%', marginBottom: '6px' }}
                >
                  <span>!</span>Emergency priority override
                </button>
                <button
                  className="quiet-action"
                  disabled={busy}
                  onClick={() => void sendBadCommand()}
                  style={{ width: '100%', borderColor: '#ef4444', color: '#fca5a5' }}
                  title="Test error handling with bad command"
                >
                  Send bad command (test error handling)
                </button>
              </div>

              <p className="sequence-note">
                <span className="sequence-line" />
                Changes follow the backend safety sequence: YELLOW → ALL RED → GREEN.
              </p>
            </section>

            {/* Input Simulator Panel */}
            <section className="panel simulation-panel">
              <div className="panel-heading">
                <div>
                  <p className="eyebrow">INPUT SIMULATOR</p>
                  <h2>Sensor & controller simulator</h2>
                </div>
                <span className="panel-mark">03</span>
              </div>

              <form className="simulation-form" onSubmit={(event) => void submitSimulation(event)}>
                <label>
                  <span>EVENT TYPE</span>
                  <select
                    value={simulation.eventType}
                    onChange={(e) => setSimulation({ ...simulation, eventType: e.target.value as EventType })}
                  >
                    <option value="ARRIVED">VEHICLE ARRIVED</option>
                    <option value="CLEARED">VEHICLE CLEARED</option>
                  </select>
                </label>
                <label>
                  <span>DIRECTION</span>
                  <select
                    value={simulation.direction}
                    onChange={(e) => setSimulation({ ...simulation, direction: e.target.value as Direction })}
                  >
                    {directions.map((d) => <option key={d}>{d}</option>)}
                  </select>
                </label>
                <label>
                  <span>VEHICLE TYPE</span>
                  <select
                    value={simulation.vehicleType}
                    onChange={(e) => setSimulation({ ...simulation, vehicleType: e.target.value as VehicleType })}
                  >
                    {vehicleTypes.map((t) => <option key={t} value={t}>{t.replace('_', ' ')}</option>)}
                  </select>
                </label>
                <label className="wide-field">
                  <span>VEHICLE ID <small>OPTIONAL</small></span>
                  <input
                    value={simulation.vehicleId}
                    onChange={(e) => setSimulation({ ...simulation, vehicleId: e.target.value })}
                    placeholder="Auto-generate if empty"
                  />
                </label>
                <button className="submit-event" type="submit" disabled={busy || !dashboard.selectedId}>
                  ＋ Record {simulation.eventType}
                </button>
              </form>

              {/* Hardware Controller Simulator Actions */}
              <div style={{ marginTop: '14px', paddingTop: '12px', borderTop: '1px solid #334155' }}>
                <p style={{ margin: '0 0 8px', fontSize: '11px', fontWeight: 700, color: '#94a3b8' }}>CONTROLLER SIMULATION ACTIONS</p>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', marginBottom: '6px' }}>
                  <button
                    type="button"
                    className="quiet-action"
                    disabled={busy || !dashboard.selectedId}
                    onClick={() => void setControllerStatus('OFFLINE')}
                    style={{ color: '#ef4444' }}
                  >
                    Simulate OFFLINE
                  </button>
                  <button
                    type="button"
                    className="quiet-action"
                    disabled={busy || !dashboard.selectedId}
                    onClick={() => void setControllerStatus('ONLINE')}
                    style={{ color: '#10b981' }}
                  >
                    Simulate ONLINE
                  </button>
                </div>
                <button
                  type="button"
                  className="primary-action"
                  disabled={busy || !dashboard.pendingCommand}
                  onClick={() => void ackPendingCommand()}
                  style={{ width: '100%' }}
                >
                  ✓ ACK pending command ({dashboard.pendingCommand ? dashboard.pendingCommand.command_id.slice(0, 8) + '...' : 'None'})
                </button>
              </div>

              <p className="simulation-footnote">Sends timestamped events to the sensor-events & controller-events APIs.</p>
            </section>

            {/* Audit Trail & Live Activity Panel */}
            <section className="panel activity-panel" id="activity-panel">
              <div className="panel-heading">
                <div>
                  <p className="eyebrow">AUDIT TRAIL</p>
                  <h2>Recent activity</h2>
                </div>
                <button className="text-button" onClick={() => void dashboard.refresh()}>Reload</button>
              </div>
              {activity.length === 0 ? (
                <div className="empty-state compact">No recent activity recorded.</div>
              ) : (
                <ol className="activity-list">
                  {activity.map((item, index) => (
                    <li key={`${item.id ?? index}-${item.event_type}`}>
                      <span className={`activity-marker ${item.event_type?.includes('RECOVERY') ? 'amber' : ''}`} />
                      <span className="activity-content">
                        <strong>{item.event_type?.replaceAll('_', ' ') ?? 'Activity'}</strong>
                        <small>{String(item.new_state ?? item.previous_state ?? item.details?.vehicleId ?? junction?.name ?? 'Junction event')}</small>
                      </span>
                      <time>{formatTime(item.created_at)}</time>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          </div>

          <footer className="page-footer">
            <span>FACTORY TRAFFIC MANAGEMENT</span>
            <span>STATE SOURCE: BACKEND API</span>
            <span>REFRESH: {dashboard.connected ? 'STREAMING (SOCKET.IO)' : '5S POLLING'}</span>
          </footer>
        </div>
      </section>
    </main>
  )
}

function SignalLight({ actual, desired }: { actual?: string; desired?: string }) {
  const isActualRed = actual === 'RED'
  const isActualYellow = actual === 'YELLOW'
  const isActualGreen = actual === 'GREEN'
  const isUnknown = !actual || actual === 'UNKNOWN'

  return (
    <>
      <i
        className={`signal-lens red ${isActualRed ? 'lit' : 'unlit'} ${desired === 'RED' ? 'desired-target' : ''}`}
        title={`Red (Actual: ${actual ?? 'UNKNOWN'}, Desired: ${desired ?? 'UNKNOWN'})`}
      />
      <i
        className={`signal-lens yellow ${isActualYellow ? 'lit' : 'unlit'} ${desired === 'YELLOW' ? 'desired-target' : ''}`}
        title={`Yellow (Actual: ${actual ?? 'UNKNOWN'}, Desired: ${desired ?? 'UNKNOWN'})`}
      />
      <i
        className={`signal-lens green ${isActualGreen ? 'lit' : 'unlit'} ${desired === 'GREEN' ? 'desired-target' : ''}`}
        title={`Green (Actual: ${actual ?? 'UNKNOWN'}, Desired: ${desired ?? 'UNKNOWN'})`}
      />
      {isUnknown && <span className="signal-unconfirmed-mark" aria-hidden="true" title="Actual state unknown">?</span>}
    </>
  )
}

export default App
