import { useEffect, useState } from 'react'
import { io, type Socket } from 'socket.io-client'

type Phase = 'NORTH_SOUTH' | 'EAST_WEST'
type Signal = 'RED' | 'YELLOW' | 'GREEN' | 'UNKNOWN'
type Direction = 'NORTH' | 'SOUTH' | 'EAST' | 'WEST'

export interface JunctionRow {
  id: string
  name: string
  mode: string
  current_phase: string
  controller_status: string
}

export interface QueueRow {
  junction_id: string
  direction: Direction
  queue_count: number
}

export interface JunctionEngineState {
  junctionId: string
  mode: string
  pendingPhase: Phase | null
  desired: { phase: Phase; step: string; signals: Record<Direction, Signal> }
  actual: { phase: Phase; step: string; signals: Record<Direction, Signal>; confirmedAt: number }
  queueCounts: Record<Direction, number>
}

export interface JunctionStatus {
  junction: JunctionRow
  queues: QueueRow[]
  state: JunctionEngineState
}

export interface HistoryRow {
  id: number
  event_type: string
  previous_state: string | null
  new_state: string | null
  details: Record<string, unknown> | null
  created_at: string
}

const API_BASE = (import.meta.env.VITE_API_URL ?? 'http://localhost:5000/api').replace(/\/$/, '')
const SOCKET_BASE = API_BASE.replace(/\/api$/, '')

async function readJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, { signal, headers: { accept: 'application/json' } })
  const payload = await response.json().catch(() => ({})) as { error?: { message?: string } }
  if (!response.ok) throw new Error(payload.error?.message ?? `Request failed (${response.status})`)
  return payload as T
}

export function useTrafficDashboard() {
  const [junctions, setJunctions] = useState<JunctionRow[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [status, setStatus] = useState<JunctionStatus | null>(null)
  const [history, setHistory] = useState<HistoryRow[]>([])
  const [connected, setConnected] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)

  async function refresh(signal?: AbortSignal) {
    try {
      const list = await readJson<{ junctions: JunctionRow[] }>('/junctions', signal)
      setJunctions(list.junctions)
      const id = selectedId || list.junctions[0]?.id || ''
      if (id && id !== selectedId) setSelectedId(id)
      if (id) {
        const [nextStatus, nextHistory] = await Promise.all([
          readJson<JunctionStatus>(`/junctions/${encodeURIComponent(id)}/status`, signal),
          readJson<{ history: HistoryRow[] }>(`/history?junctionId=${encodeURIComponent(id)}&limit=20`, signal),
        ])
        setStatus(nextStatus)
        setHistory(nextHistory.history)
      }
      setError('')
      setLastUpdated(new Date())
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return
      setError(caught instanceof Error ? caught.message : 'Unable to reach the API')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    const controller = new AbortController()
    void refresh(controller.signal)
    return () => controller.abort()
  }, [])

  useEffect(() => {
    if (!selectedId) return
    const controller = new AbortController()
    void Promise.all([
      readJson<JunctionStatus>(`/junctions/${encodeURIComponent(selectedId)}/status`, controller.signal),
      readJson<{ history: HistoryRow[] }>(`/history?junctionId=${encodeURIComponent(selectedId)}&limit=20`, controller.signal),
    ]).then(([nextStatus, nextHistory]) => {
      setStatus(nextStatus)
      setHistory(nextHistory.history)
      setLastUpdated(new Date())
      setError('')
    }).catch((caught: unknown) => {
      if (!(caught instanceof DOMException && caught.name === 'AbortError')) {
        setError(caught instanceof Error ? caught.message : 'Unable to load junction details')
      }
    })
    return () => controller.abort()
  }, [selectedId])

  useEffect(() => {
    const socket: Socket = io(SOCKET_BASE, { autoConnect: true, reconnection: true, timeout: 2500 })
    const onConnect = () => setConnected(true)
    const onDisconnect = () => setConnected(false)
    const onUpdate = (event: { junctionId?: string; state?: JunctionEngineState }) => {
      if (!event.state || event.junctionId !== selectedId) return
      setStatus((previous) => previous ? { ...previous, state: event.state! } : previous)
      setLastUpdated(new Date())
    }
    socket.on('connect', onConnect)
    socket.on('disconnect', onDisconnect)
    socket.on('connect_error', onDisconnect)
    socket.on('junction:update', onUpdate)
    return () => {
      socket.off('connect', onConnect)
      socket.off('disconnect', onDisconnect)
      socket.off('connect_error', onDisconnect)
      socket.off('junction:update', onUpdate)
      socket.close()
    }
  }, [selectedId])

  useEffect(() => {
    const timer = window.setInterval(() => {
      void refresh()
    }, connected ? 15_000 : 5_000)
    return () => window.clearInterval(timer)
  }, [connected, selectedId])

  async function selectJunction(id: string) {
    setSelectedId(id)
  }

  async function postJson<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    })
    const payload = await response.json().catch(() => ({})) as { error?: { message?: string } }
    if (!response.ok) throw new Error(payload.error?.message ?? `Request failed (${response.status})`)
    return payload as T
  }

  return {
    junctions,
    selectedId,
    status,
    history,
    connected,
    loading,
    error,
    lastUpdated,
    refresh,
    selectJunction,
    postCommand: (body: unknown) => postJson('/commands', body),
    postSensorEvent: (body: unknown) => postJson('/sensor-events', body),
  }
}
