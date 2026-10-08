import { useEffect, useState, useRef } from 'react'
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

export interface CommandRow {
  id: number
  command_id: string
  junction_id: string
  command: string
  direction: string | null
  requested_state: string | null
  status: string
  created_at: string
  acknowledged_at: string | null
}

const API_BASE = (import.meta.env.VITE_API_URL ?? 'http://localhost:5000/api').replace(/\/$/, '')
const SOCKET_BASE = API_BASE.replace(/\/api$/, '')

function getInitialJunctionId(): string {
  if (typeof window === 'undefined') return ''
  const searchParam =
    new URLSearchParams(window.location.search).get('junction') ||
    new URLSearchParams(window.location.search).get('junctionId')
  if (searchParam) return searchParam
  const hash = window.location.hash.replace(/^#\/?/, '').trim()
  if (hash) return hash
  return ''
}

async function readJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    signal,
    headers: { accept: 'application/json' },
  })
  const payload = (await response.json().catch(() => ({}))) as { error?: { message?: string } }
  if (!response.ok) throw new Error(payload.error?.message ?? `Request failed (${response.status})`)
  return payload as T
}

export function useTrafficDashboard() {
  const [junctions, setJunctions] = useState<JunctionRow[]>([])
  const [selectedId, setSelectedId] = useState(getInitialJunctionId)
  const [status, setStatus] = useState<JunctionStatus | null>(null)
  const [history, setHistory] = useState<HistoryRow[]>([])
  const [commands, setCommands] = useState<CommandRow[]>([])
  const [connected, setConnected] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)

  // Refs to keep latest selectedId for socket callbacks without recreating the socket
  const selectedIdRef = useRef<string>(selectedId)
  useEffect(() => {
    selectedIdRef.current = selectedId
  }, [selectedId])

  // Socket reference – created once
  const socketRef = useRef<Socket | null>(null)



  async function refresh(signal?: AbortSignal) {
    try {
      const list = await readJson<{ junctions: JunctionRow[] }>('/junctions', signal)
      setJunctions(list.junctions)
      const currentSelected = selectedId || list.junctions[0]?.id || ''
      if (currentSelected && currentSelected !== selectedId) {
        setSelectedId(currentSelected)
      }
      if (currentSelected) {
        try {
          const [nextStatus, nextHistory, nextCommands] = await Promise.all([
            readJson<JunctionStatus>(`/junctions/${encodeURIComponent(currentSelected)}/status`, signal),
            readJson<{ history: HistoryRow[] }>(`/history?junctionId=${encodeURIComponent(currentSelected)}&limit=20`, signal).catch(() => ({ history: [] })),
            readJson<{ commands: CommandRow[] }>(`/commands?junctionId=${encodeURIComponent(currentSelected)}&limit=10`, signal).catch(() => ({ commands: [] })),
          ])
          setStatus(nextStatus)
          setHistory(nextHistory.history)
          setCommands(nextCommands.commands)
          setError('')
        } catch (fetchError) {
          if (fetchError instanceof DOMException && fetchError.name === 'AbortError') return
          setStatus(null)
          setError(fetchError instanceof Error ? fetchError.message : 'Unable to load junction')
        }
      }
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
    Promise.all([
      readJson<JunctionStatus>(`/junctions/${encodeURIComponent(selectedId)}/status`, controller.signal),
      readJson<{ history: HistoryRow[] }>(`/history?junctionId=${encodeURIComponent(selectedId)}&limit=20`, controller.signal).catch(() => ({ history: [] })),
      readJson<{ commands: CommandRow[] }>(`/commands?junctionId=${encodeURIComponent(selectedId)}&limit=10`, controller.signal).catch(() => ({ commands: [] })),
    ])
      .then(([nextStatus, nextHistory, nextCommands]) => {
        setStatus(nextStatus)
        setHistory(nextHistory.history)
        setCommands(nextCommands.commands)
        setLastUpdated(new Date())
        setError('')
      })
      .catch((caught: unknown) => {
        if (!(caught instanceof DOMException && caught.name === 'AbortError')) {
          setStatus(null)
          setError(caught instanceof Error ? caught.message : 'Unable to load junction details')
        }
      })
    return () => controller.abort()
  }, [selectedId])






  useEffect(() => {
    const socket = io(SOCKET_BASE, { reconnection: true, transports: ['websocket'], timeout: 2500 })
    socketRef.current = socket

    // Allow tests to force a disconnect without a real network failure
    window.addEventListener('force-disconnect', () => {
      socket.disconnect()
    })

    const onConnect = () => setConnected(true)
    const onDisconnect = () => setConnected(false)
    const onUpdate = (event: { junctionId?: string; state?: JunctionEngineState }) => {
      if (!event.state || event.junctionId !== selectedIdRef.current) return
      setStatus((prev) => (prev ? { ...prev, state: event.state! } : prev))
      setLastUpdated(new Date())
    }
    const onAck = () => {
      if (selectedIdRef.current) {
        readJson<{ commands: CommandRow[] }>(`/commands?junctionId=${encodeURIComponent(selectedIdRef.current)}&limit=10`)
          .then((res) => setCommands(res.commands))
          .catch(() => undefined)
      }
    }
    socket.on('connect', onConnect)
    socket.on('disconnect', onDisconnect)
    socket.on('connect_error', onDisconnect)
    socket.on('junction:update', onUpdate)
    socket.on('controller:ack', onAck)
    return () => {
      socket.off('connect', onConnect)
      socket.off('disconnect', onDisconnect)
      socket.off('connect_error', onDisconnect)
      socket.off('junction:update', onUpdate)
      socket.off('controller:ack', onAck)
      socket.close()
    }
  }, []);
  useEffect(() => {
  const timer = window.setInterval(() => {
    void refresh()
  }, connected ? 15000 : 5000)
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
    const payload = (await response.json().catch(() => ({}))) as { error?: { message?: string } }
    if (!response.ok) throw new Error(payload.error?.message ?? `Request failed (${response.status})`)
    return payload as T
  }

  const pendingCommand = commands.find((c) => c.status === 'PENDING') ?? null

  return {
    junctions,
    selectedId,
    status,
    history,
    commands,
    pendingCommand,
    connected,
    loading,
    error,
    lastUpdated,
    refresh,
    selectJunction,
    postCommand: (body: unknown) => postJson('/commands', body),
    postSensorEvent: (body: unknown) => postJson('/sensor-events', body),
    postControllerEvent: (body: unknown) => postJson('/controller-events', body),
    postRaw: (path: string, body: unknown) => postJson(path, body),
  }
}
