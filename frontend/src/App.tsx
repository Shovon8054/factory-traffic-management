import { useEffect, useState } from 'react'
import './App.css'
import './signals.css'
import { useTrafficDashboard } from './useTrafficDashboard'

type Direction = 'NORTH' | 'SOUTH' | 'EAST' | 'WEST'
type Phase = 'NORTH_SOUTH' | 'EAST_WEST'
type VehicleType = 'CAR' | 'MOTORCYCLE' | 'BUS' | 'TRUCK' | 'EMERGENCY' | 'EMPLOYEE_VEHICLE'

const directions: Direction[] = ['NORTH', 'EAST', 'SOUTH', 'WEST']
const vehicleTypes: VehicleType[] = ['CAR', 'MOTORCYCLE', 'BUS', 'TRUCK', 'EMERGENCY', 'EMPLOYEE_VEHICLE']
function formatTime(value?: string | number | Date | null) {
  if (!value) return 'Time unavailable'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Time unavailable' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function App() {
  const dashboard = useTrafficDashboard()
  const [phase, setPhase] = useState<Phase>('NORTH_SOUTH')
  const [simulation, setSimulation] = useState({ direction: 'NORTH' as Direction, vehicleType: 'CAR' as VehicleType, vehicleId: '' })
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState('')
  const [notice, setNotice] = useState('')

  const selected = dashboard.status
  const state = selected?.state
  const junction = selected?.junction
  const actualSignals = state?.actual?.signals
  const isDegraded = state?.mode === 'DEGRADED' || junction?.controller_status === 'DEGRADED'
  const isRecovering = junction?.controller_status === 'RECOVERING'
  const emergencyActive = state?.mode === 'EMERGENCY'

  useEffect(() => {
    if (state?.desired?.phase) setPhase(state.desired.phase)
  }, [state?.desired?.phase])

  async function submitCommand(type: 'MANUAL_MODE_REQUEST' | 'EMERGENCY_REQUEST' | 'RETURN_TO_AUTOMATIC') {
    if (!dashboard.selectedId) return
    setBusy(true)
    setActionError('')
    setNotice('')
    try {
      const body = type === 'RETURN_TO_AUTOMATIC'
        ? { type, junctionId: dashboard.selectedId }
        : type === 'EMERGENCY_REQUEST'
          ? { type, junctionId: dashboard.selectedId, emergencyId: `web-${crypto.randomUUID()}`, phase, occurredAt: Date.now() }
          : { type, junctionId: dashboard.selectedId, phase }
      await dashboard.postCommand(body)
      setNotice(type === 'EMERGENCY_REQUEST' ? 'Emergency request sent' : type === 'MANUAL_MODE_REQUEST' ? 'Manual phase request sent' : 'Automatic mode requested')
      await dashboard.refresh()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Command could not be sent')
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
        eventType: 'ARRIVED',
        vehicleId: simulation.vehicleId.trim() || `vehicle-${crypto.randomUUID().slice(0, 8)}`,
        vehicleType: simulation.vehicleType,
        sensorTimestamp: new Date().toISOString(),
      })
      setNotice('Sensor event recorded')
      setSimulation((current) => ({ ...current, vehicleId: '' }))
      await dashboard.refresh()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Simulation event failed')
    } finally {
      setBusy(false)
    }
  }

  const activity = dashboard.history
    .filter((item) => item.event_type !== 'TICK')
    .slice(0, 6)
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
          <div className="topbar-brand"><span className="brand-square">F</span><span>FACTORY TRAFFIC</span><span className="topbar-divider">/</span><span className="muted">CONTROL ROOM</span></div>
          <div className="topbar-right">
            <span className={`connection-pill ${dashboard.connected ? 'connected' : ''}`}><i />{dashboard.connected ? 'LIVE' : 'POLLING'}</span>
            <time>{new Date().toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}</time>
          </div>
        </header>

        <div className="page-content">
          <div className="page-heading">
            <div><p className="eyebrow">TRAFFIC OPERATIONS <span>•</span> SHIFT MONITOR</p><h1>Junction overview</h1><p className="subheading">Live signal state, demand, and controller activity.</p></div>
            <button className="refresh-button" onClick={() => void dashboard.refresh()} disabled={dashboard.loading} title="Refresh data"><span className={dashboard.loading ? 'refresh-glyph spinning' : 'refresh-glyph'}>↻</span><span>Refresh</span></button>
          </div>

          {emergencyActive && <div className="emergency-banner" role="alert"><span className="emergency-symbol">!</span><div><strong>Emergency priority active</strong><small>{state?.pendingPhase ? `Next requested phase: ${state.pendingPhase.replace('_', ' ')}` : 'Emergency vehicle phase has priority'}</small></div><span className="banner-pulse" /> </div>}
          {isDegraded && <div className="alert-banner danger" role="alert"><strong>Controller degraded</strong><span>Signals are held at the safe fallback. Reconnect the controller before resuming.</span></div>}
          {isRecovering && <div className="alert-banner warning" role="alert"><strong>Startup recovery in progress</strong><span>Controller state is unconfirmed; desired signals are ALL RED.</span></div>}
          {dashboard.error && <div className="alert-banner danger" role="alert"><strong>Data connection issue</strong><span>{dashboard.error}</span><button onClick={() => void dashboard.refresh()}>Retry</button></div>}
          {actionError && <div className="alert-banner danger" role="alert"><strong>Action failed</strong><span>{actionError}</span><button onClick={() => setActionError('')} aria-label="Dismiss action error">Dismiss</button></div>}
          {notice && <div className="inline-notice" role="status">{notice}<button onClick={() => setNotice('')} aria-label="Dismiss notice">×</button></div>}

          <section className="overview-strip" aria-label="Overview metrics">
            <div className="metric"><span>JUNCTIONS</span><strong>{dashboard.junctions.length.toString().padStart(2, '0')}</strong><small>registered</small></div>
            <div className="metric"><span>SELECTED</span><strong>{junction?.id ?? '—'}</strong><small>{junction?.name ?? 'No junction selected'}</small></div>
            <div className="metric"><span>MODE</span><strong className={emergencyActive ? 'text-red' : ''}>{state?.mode ?? '—'}</strong><small>{junction?.controller_status ?? 'Awaiting status'}</small></div>
            <div className="metric"><span>VEHICLES QUEUED</span><strong>{totalQueued.toString().padStart(2, '0')}</strong><small>across approaches</small></div>
            <div className="metric metric-updated"><span>LAST UPDATED</span><strong>{formatTime(dashboard.lastUpdated)}</strong><small>{dashboard.connected ? 'Socket.IO stream' : 'Polling every 5 seconds'}</small></div>
          </section>

          <div className="main-grid">
            <section className="panel junction-panel">
              <div className="panel-heading"><div><p className="eyebrow">NETWORK</p><h2>Junctions <span className="count-tag">{dashboard.junctions.length}</span></h2></div><span className="panel-mark">01</span></div>
              {dashboard.junctions.length === 0 ? <div className="empty-state">{dashboard.loading ? 'Loading junctions…' : 'No junctions available'}</div> : (
                <div className="junction-list">
                  {dashboard.junctions.map((item) => {
                    const active = item.id === dashboard.selectedId
                    const health = item.controller_status?.toUpperCase() ?? 'UNKNOWN'
                    return <button className={`junction-row ${active ? 'active' : ''}`} key={item.id} onClick={() => dashboard.selectJunction(item.id)}>
                      <span className="junction-initial">{item.id.slice(0, 1)}</span>
                      <span className="junction-copy"><strong>{item.name}</strong><small>{item.id} <span>·</span> {item.current_phase?.replace('_', ' ')}</small></span>
                      <span className={`health-dot ${health === 'ONLINE' ? 'healthy' : health === 'RECOVERING' ? 'caution' : 'unhealthy'}`} />
                    </button>
                  })}
                </div>
              )}
            </section>

            <section className="panel intersection-panel">
              <div className="panel-heading"><div><p className="eyebrow">SELECTED JUNCTION <span>·</span> {junction?.id ?? '—'}</p><h2>{junction?.name ?? 'Intersection state'}</h2></div><span className={`mode-badge ${isDegraded ? 'bad' : emergencyActive ? 'emergency' : ''}`}>{state?.mode ?? 'UNKNOWN'}</span></div>
              <div className="intersection-wrap" aria-label="Backend-reported intersection signal state">
                <div className="road-label north"><span>N</span><small>{selected?.queues?.find((queue) => queue.direction === 'NORTH')?.queue_count ?? state?.queueCounts?.NORTH ?? 0} waiting</small></div>
                <div className="signal-stack north-signal" aria-label={`North actual ${actualSignals?.NORTH ?? 'UNKNOWN'}, desired ${state?.desired?.signals?.NORTH ?? 'UNKNOWN'}`}><SignalLight actual={actualSignals?.NORTH} desired={state?.desired?.signals?.NORTH} /></div>
                <div className="road-label west"><span>W</span><small>{selected?.queues?.find((queue) => queue.direction === 'WEST')?.queue_count ?? state?.queueCounts?.WEST ?? 0}</small></div>
                <div className="signal-stack west-signal" aria-label={`West actual ${actualSignals?.WEST ?? 'UNKNOWN'}, desired ${state?.desired?.signals?.WEST ?? 'UNKNOWN'}`}><SignalLight actual={actualSignals?.WEST} desired={state?.desired?.signals?.WEST} /></div>
                <div className="signal-stack east-signal" aria-label={`East actual ${actualSignals?.EAST ?? 'UNKNOWN'}, desired ${state?.desired?.signals?.EAST ?? 'UNKNOWN'}`}><SignalLight actual={actualSignals?.EAST} desired={state?.desired?.signals?.EAST} /></div>
                <div className="road-label east"><span>E</span><small>{selected?.queues?.find((queue) => queue.direction === 'EAST')?.queue_count ?? state?.queueCounts?.EAST ?? 0}</small></div>
                <div className="signal-stack south-signal" aria-label={`South actual ${actualSignals?.SOUTH ?? 'UNKNOWN'}, desired ${state?.desired?.signals?.SOUTH ?? 'UNKNOWN'}`}><SignalLight actual={actualSignals?.SOUTH} desired={state?.desired?.signals?.SOUTH} /></div>
                <div className="road-label south"><span>S</span><small>{selected?.queues?.find((queue) => queue.direction === 'SOUTH')?.queue_count ?? state?.queueCounts?.SOUTH ?? 0} waiting</small></div>
              </div>
              <div className="intersection-readout" aria-label="Controller-confirmed actual state"><span>ACTUAL</span><strong>{state?.actual?.step ?? 'UNKNOWN'}</strong><small>{state?.actual?.phase?.replace('_', ' ') ?? 'NOT CONFIRMED'}</small></div>
              <div className="state-legend"><span><i className="legend-dot red" />RED</span><span><i className="legend-dot yellow" />YELLOW</span><span><i className="legend-dot green" />GREEN</span><span className="legend-note">Signal values from controller-confirmed backend state</span></div>
              <div className="desired-state"><span>DESIRED</span><strong>{state?.desired?.step ?? 'UNKNOWN'}</strong><small>{state?.desired?.phase?.replace('_', ' ') ?? 'No state reported'}</small><span className="desired-mark">→</span></div>
            </section>

            <section className="panel controls-panel" id="control-panel">
              <div className="panel-heading"><div><p className="eyebrow">OPERATOR ACTIONS</p><h2>Control panel</h2></div><span className="panel-mark">02</span></div>
              <label className="field-label" htmlFor="phase-target">TARGET PHASE</label>
              <div className="phase-select" role="group" aria-label="Target phase">
                {(['NORTH_SOUTH', 'EAST_WEST'] as Phase[]).map((item) => <button type="button" key={item} aria-pressed={phase === item} className={phase === item ? 'chosen' : ''} onClick={() => setPhase(item)}><span>{item === 'NORTH_SOUTH' ? '↕' : '↔'}</span>{item.replace('_', ' ')}</button>)}
              </div>
              <div className="control-actions">
                <button className="primary-action" disabled={busy || !dashboard.selectedId} onClick={() => void submitCommand('MANUAL_MODE_REQUEST')}><span>◉</span>Request manual phase</button>
                <button className="emergency-action" disabled={busy || !dashboard.selectedId} onClick={() => void submitCommand('EMERGENCY_REQUEST')}><span>!</span>Emergency override</button>
                <button className="quiet-action" disabled={busy || !dashboard.selectedId} onClick={() => void submitCommand('RETURN_TO_AUTOMATIC')}>Return to automatic</button>
              </div>
              <p className="sequence-note"><span className="sequence-line" />Changes follow the safety sequence: YELLOW → ALL RED → GREEN.</p>
            </section>

            <section className="panel simulation-panel">
              <div className="panel-heading"><div><p className="eyebrow">INPUT SIMULATOR</p><h2>Vehicle arrival</h2></div><span className="panel-mark">03</span></div>
              <form className="simulation-form" onSubmit={(event) => void submitSimulation(event)}>
                <label><span>DIRECTION</span><select value={simulation.direction} onChange={(event) => setSimulation({ ...simulation, direction: event.target.value as Direction })}>{directions.map((direction) => <option key={direction}>{direction}</option>)}</select></label>
                <label><span>VEHICLE TYPE</span><select value={simulation.vehicleType} onChange={(event) => setSimulation({ ...simulation, vehicleType: event.target.value as VehicleType })}>{vehicleTypes.map((type) => <option key={type} value={type}>{type.replace('_', ' ')}</option>)}</select></label>
                <label className="wide-field"><span>VEHICLE ID <small>OPTIONAL</small></span><input value={simulation.vehicleId} onChange={(event) => setSimulation({ ...simulation, vehicleId: event.target.value })} placeholder="Auto-generate if empty" /></label>
                <button className="submit-event" type="submit" disabled={busy || !dashboard.selectedId}>＋ Record arrival</button>
              </form>
              <p className="simulation-footnote">Sends a timestamped event to the sensor-events API.</p>
            </section>

            <section className="panel activity-panel" id="activity-panel">
              <div className="panel-heading"><div><p className="eyebrow">AUDIT TRAIL</p><h2>Recent activity</h2></div><button className="text-button" onClick={() => void dashboard.refresh()}>Reload</button></div>
              {activity.length === 0 ? <div className="empty-state compact">No recent activity recorded.</div> : <ol className="activity-list">{activity.map((item, index) => <li key={`${item.id ?? index}-${item.event_type}`}><span className={`activity-marker ${item.event_type?.includes('RECOVERY') ? 'amber' : ''}`} /><span className="activity-content"><strong>{item.event_type?.replaceAll('_', ' ') ?? 'Activity'}</strong><small>{String(item.new_state ?? item.previous_state ?? item.details?.vehicleId ?? junction?.name ?? 'Junction event')}</small></span><time>{formatTime(item.created_at)}</time></li>)}</ol>}
            </section>
          </div>
          <footer className="page-footer"><span>FACTORY TRAFFIC MANAGEMENT</span><span>STATE SOURCE: BACKEND API</span><span>REFRESH {dashboard.connected ? 'STREAMING' : '5S POLL'}</span></footer>
        </div>
      </section>
    </main>
  )
}

function SignalLight({ actual, desired }: { actual?: string; desired?: string }) {
  const unconfirmed = actual === undefined || actual === 'UNKNOWN'
  const shownState = unconfirmed ? desired : actual

  return <>
    <i className={`signal-lens red ${shownState === 'RED' ? 'lit' : ''}`} />
    <i className={`signal-lens yellow ${shownState === 'YELLOW' ? 'lit' : ''}`} />
    <i className={`signal-lens green ${shownState === 'GREEN' ? 'lit' : ''}`} />
    {unconfirmed && <span className="signal-unconfirmed-mark" aria-hidden="true">?</span>}
  </>
}

export default App
