import { expect, test } from 'bun:test'

function gate(body: string, code = '503', expected = '1.2.3') {
  const script = `source deploy/lib/common.sh
url_get() { return 1; }
curl() { printf '%s\n%s' "$TEST_BODY" "$TEST_CODE"; }
sleep() { SECONDS=$((SECONDS + 3)); }
wait_health http://fixture "$TEST_EXPECTED" 2
rc=$?
printf '\nRESULT:%s:%s\n' "$rc" "$HEALTH_FAILURE"`
  const result = Bun.spawnSync(['bash', '-c', script], {
    env: { ...process.env, TEST_BODY: body, TEST_CODE: code, TEST_EXPECTED: expected },
    stdout: 'pipe', stderr: 'pipe'
  })
  return result.stdout.toString() + result.stderr.toString()
}

const body = (version: string, embedder = 'ok') => JSON.stringify({
  status: 'degraded', version, checks: { database: 'degraded', embedder }
})

test('expected degraded 503 is accepted with warning', () => {
  const output = gate(body('1.2.3', 'not ready'))
  expect(output).toContain('RESULT:0:')
  expect(output).toContain('degraded database')
})
test('wrong version is rejected', () => expect(gate(body('9.0.0'))).toContain('RESULT:1:version'))
test('failed embedder is rejected', () => expect(gate(body('1.2.3', 'failed'))).toContain('RESULT:1:embedder'))
test('malformed and duplicate JSON are rejected', () => {
  expect(gate('{')).toContain('RESULT:1:contract')
  expect(gate('{"status":"degraded","status":"degraded"}')).toContain('RESULT:1:contract')
})
test('transport failure does not become success', () => expect(gate('', '000')).toContain('RESULT:1:timeout'))
