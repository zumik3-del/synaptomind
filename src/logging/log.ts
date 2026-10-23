import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { config as appConfig } from '../config'

const SENSITIVE_SUBSTRINGS = ['token', 'key', 'secret', 'password', 'auth']
const SAFE_SUBSTRINGS = ['token_count', 'tokenizer', 'tokenize', 'keyboard', 'keyring']

const DEBUG_CACHE_TTL = 5000

export type LogLevel = 'debug' | 'info' | 'warning' | 'error'

export interface LogEntry {
  timestamp: string
  level: LogLevel
  type: string
  source: string
  message: string
  metadata?: Record<string, unknown>
  error?: string
}

export interface LogSink {
  write(entry: LogEntry): void
  close(): void
}

type WritableLike = { write(chunk: string): boolean }

function envStr(name: string): string | undefined {
  const v = process.env[name]
  return v === undefined ? undefined : v
}

function envInt(name: string, fallback: number): number {
  const v = process.env[name]
  if (v === undefined) return fallback
  const n = parseInt(v, 10)
  return Number.isFinite(n) ? n : fallback
}

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warning: 2, error: 3 }

function isWarnOrError(level: LogLevel): boolean {
  return level === 'warning' || level === 'error'
}

export interface LoggerConfig {
  level?: LogLevel
  file?: string
  format?: 'text' | 'json'
  fileMaxBytes?: number
  fileMaxFiles?: number
  stdio?: boolean
  stdout?: WritableLike
  stderr?: WritableLike
  log?: { level?: LogLevel; file?: string; format?: 'text' | 'json'; fileMaxBytes?: number; fileMaxFiles?: number }
}

function formatEntry(entry: LogEntry, format: 'text' | 'json'): string {
  if (format === 'json') {
    const obj: Record<string, unknown> = {
      ts: entry.timestamp,
      level: entry.level,
      type: entry.type,
      source: entry.source,
      msg: entry.message
    }
    if (entry.metadata) obj.meta = entry.metadata
    if (entry.error) obj.error = entry.error
    return JSON.stringify(obj)
  }
  const meta = entry.metadata ? ' ' + JSON.stringify(entry.metadata) : ''
  return `${entry.timestamp} ${entry.level} [${entry.type}] [${entry.source}] ${entry.message}${meta}`
}

export class StreamSink implements LogSink {
  constructor(private opts: { stdout: WritableLike; stderr: WritableLike; stdio: boolean; format: 'text' | 'json' }) {}
  write(entry: LogEntry): void {
    const stream = this.opts.stdio || isWarnOrError(entry.level) ? this.opts.stderr : this.opts.stdout
    try { stream.write(formatEntry(entry, this.opts.format) + '\n') } catch { /* ignore */ }
  }
  close(): void {}
}

export class FileSink implements LogSink {
  private disabled = false
  constructor(private path: string, private maxBytes: number, private maxFiles: number, private format: 'text' | 'json') {}
  write(entry: LogEntry): void {
    if (this.disabled || !this.path) return
    try {
      const line = formatEntry(entry, this.format) + '\n'
      const dir = join(this.path, '..')
      try { mkdirSync(dir, { recursive: true }) } catch { /* ignore */ }
      if (existsSync(this.path)) {
        try {
          const st = statSync(this.path)
          if (st.size + Buffer.byteLength(line) > this.maxBytes) this.rotate()
        } catch { /* ignore */ }
      }
      appendFileSync(this.path, line)
    } catch (e) {
      this.disabled = true
      try { process.stderr.write(`[logs] file sink disabled: ${e}\n`) } catch { /* ignore */ }
    }
  }
  private rotate(): void {
    try {
      const oldest = `${this.path}.${this.maxFiles}`
      if (existsSync(oldest)) try { unlinkSync(oldest) } catch { /* ignore */ }
      for (let i = this.maxFiles - 1; i >= 1; i--) {
        const from = `${this.path}.${i}`
        const to = `${this.path}.${i + 1}`
        if (existsSync(from)) try { renameSync(from, to) } catch { /* ignore */ }
      }
      if (existsSync(this.path)) try { renameSync(this.path, `${this.path}.1`) } catch { /* ignore */ }
    } catch (e) {
      this.disabled = true
      try { process.stderr.write(`[logs] rotation failed: ${e}\n`) } catch { /* ignore */ }
    }
  }
  close(): void {}
}

export class CompositeSink implements LogSink {
  constructor(private sinks: LogSink[]) {}
  write(entry: LogEntry): void {
    for (const s of this.sinks) try { s.write(entry) } catch { /* ignore */ }
  }
  close(): void {
    for (const s of this.sinks) try { s.close() } catch { /* ignore */ }
  }
}

export class Logger {
  private showDebugCache: boolean | null = null
  private debugCacheTime = 0

  private level: LogLevel
  private file: string
  private format: 'text' | 'json'
  private fileMaxBytes: number
  private fileMaxFiles: number
  private stdio: boolean
  private stdout: WritableLike
  private stderr: WritableLike
  private sinks: LogSink[]

  constructor(config: LoggerConfig | Record<string, unknown> = appConfig as unknown as LoggerConfig) {
    const c = (config ?? {}) as LoggerConfig
    const log = c.log ?? {}
    this.level = (c.level ?? log.level ?? envStr('SYNAPTOMIND_LOG_LEVEL') ?? 'info') as LogLevel
    if (!['debug', 'info', 'warning', 'error'].includes(this.level)) this.level = 'info'
    this.file = c.file ?? log.file ?? envStr('SYNAPTOMIND_LOG_FILE') ?? ''
    const fmt = c.format ?? log.format ?? envStr('SYNAPTOMIND_LOG_FORMAT') ?? 'text'
    this.format = fmt === 'json' ? 'json' : 'text'
    this.fileMaxBytes = c.fileMaxBytes ?? log.fileMaxBytes ?? envInt('SYNAPTOMIND_LOG_FILE_MAX_BYTES', 10485760)
    this.fileMaxFiles = c.fileMaxFiles ?? log.fileMaxFiles ?? envInt('SYNAPTOMIND_LOG_FILE_MAX_FILES', 3)
    this.stdio = c.stdio ?? process.argv.includes('--stdio')
    this.stdout = c.stdout ?? process.stdout
    this.stderr = c.stderr ?? process.stderr

    const sinks: LogSink[] = []
    sinks.push(new StreamSink({ stdout: this.stdout, stderr: this.stderr, stdio: this.stdio, format: this.format }))
    if (this.file) sinks.push(new FileSink(this.file, this.fileMaxBytes, this.fileMaxFiles, this.format))
    this.sinks = sinks
  }

  private showDebugEnabled(): boolean {
    const now = Date.now()
    if (this.showDebugCache !== null && now - this.debugCacheTime < DEBUG_CACHE_TTL) return this.showDebugCache
    this.showDebugCache = process.env.SYNAPTOMIND_DEBUG === 'true'
    this.debugCacheTime = now
    return this.showDebugCache
  }

  private sanitizeMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
    if (!metadata) return metadata
    const cleaned: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(metadata)) {
      const kl = k.toLowerCase()
      if (SENSITIVE_SUBSTRINGS.some(sub => kl.includes(sub)) && !SAFE_SUBSTRINGS.some(sub => kl.includes(sub))) cleaned[k] = '***'
      else cleaned[k] = v
    }
    return cleaned
  }

  insertLog(level: LogLevel, type_: string, message: string, metadata?: Record<string, unknown>, source = 'synaptomind', timestamp?: string): void {
    if (level === 'debug' && !this.showDebugEnabled()) return
    if (LEVEL_RANK[level] < LEVEL_RANK[this.level]) return

    const metaCopy = metadata ? { ...metadata } : undefined
    let errorVal: string | null = null
    if (metaCopy && 'error' in metaCopy) {
      errorVal = String(metaCopy.error)
      delete metaCopy.error
    }
    const sanitized = this.sanitizeMetadata(metaCopy)
    const now = timestamp ?? new Date().toISOString()

    const entry: LogEntry = { timestamp: now, level, type: type_, source, message, metadata: sanitized, error: errorVal ?? undefined }

    for (const s of this.sinks) try { s.write(entry) } catch { /* ignore */ }
  }

  closeLogDb(): void {
    for (const s of this.sinks) try { s.close() } catch { /* ignore */ }
    this.showDebugCache = null
    this.debugCacheTime = 0
  }
}

const defaultStore = new Logger()

export function insertLog(level: LogLevel, type_: string, message: string, metadata?: Record<string, unknown>, source = 'synaptomind', timestamp?: string): void {
  defaultStore.insertLog(level, type_, message, metadata, source, timestamp)
}

export function closeLogDb(): void {
  defaultStore.closeLogDb()
}
