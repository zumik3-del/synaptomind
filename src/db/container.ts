// Compatibility re-export: the connection context lives in `src/context/`.
// Kept so existing importers (tests, the embedder child, the test helpers) and
// suites that mock this specifier keep working; new code imports the context
// module directly.
export * from '../context/container'
