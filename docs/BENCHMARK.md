# SynaptoMind Benchmarks

**Date**: 2026-09-05 · **Version**: 0.5.0 · **Env**: Debian 12, 4 cores, 8GB RAM

---

## Search Performance

### 10K Thoughts

| Mode | p50 | qps | avg_similarity |
|------|-----|-----|----------------|
| **Hybrid** (vector + BM25) | 70 ms | 13.3 | 0.85 |
| **Vector** (semantic only) | 72 ms | 13.5 | 0.81 |
| **BM25** (text only) | 64 ms | 15.6 | 0.87 |

### 100K Thoughts

| Mode | p50 | qps | avg_similarity |
|------|-----|-----|----------------|
| **Hybrid** | 73 ms | 13.4 | 0.77 |
| **Vector** | 81 ms | 12.0 | 0.80 |
| **BM25** | 74 ms | 13.6 | 0.73 |

### Frontier (next-action ranking)

| Dataset | p50 |
|---------|-----|
| 10K | 125 ms |
| 100K | 664 ms |

---

## Write Throughput (Seed)

| Metric | 10K | 100K |
|--------|-----|------|
| Thoughts/sec | 125 | 77 |
| Edges/sec | 570 | 1100 |
| DB size | 42 MB | 145 MB |

---

## Embedder Throughput

| Config | embeddings/sec |
|--------|----------------|
| Default (batch=8, interval=3s) | 5 |
| Optimized (batch=32, interval=500ms) | **60** |

---

## Key Numbers

- **Search latency**: 64–81 ms p50 (10K–100K dataset)
- **Search throughput**: 12–16 qps
- **Semantic similarity**: 0.73–0.87 avg
- **Write speed**: 77–125 thoughts/sec
- **Embedding speed**: 60/sec (optimized)
- **Scaling 10K→100K**: ~2x latency, ~0.7x throughput

---

## Methodology

- Benchmarks run via HTTP API (100 queries per mode, 10 warmup)
- Embeddings: Xenova/multilingual-e5-small (384d, local)
- Database: SQLite with WAL mode, vec0 + FTS5
- Write tests: sequential single-threaded, no concurrent embedder
- Server: Bun 1.4.2, direct install (no Docker)
