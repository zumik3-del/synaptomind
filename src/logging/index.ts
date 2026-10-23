export {
  closeLogDb,
  getLogDb,
  insertLog,
  Logger,
  LogStore,
  StreamSink,
  FileSink,
  CompositeSink
} from './log'
export type {
  LogLevel,
  LogEntry,
  LogSink,
  LoggerConfig
} from './log'
export { migrateLogsDb } from './migrate'
export type { MigrateOpts, MigrateResult } from './migrate'
