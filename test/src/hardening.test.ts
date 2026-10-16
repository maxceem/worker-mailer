import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { WorkerMailer } from '../../src/mailer'
import { Email, formatAddress } from '../../src/email'
import { connect } from 'cloudflare:sockets'

vi.mock('cloudflare:sockets', () => ({
  connect: vi.fn(),
}))

const line = (text: string) => ({ value: new TextEncoder().encode(text) })

/** The session up to a signed-in, TLS-from-the-start connection. */
const SIGNED_IN = [
  line('220 smtp.example.com ready\r\n'),
  line('250-smtp.example.com\r\n250 AUTH PLAIN\r\n'),
  line('235 Authentication successful\r\n'),
]

const OPTIONS = {
  host: 'smtp.example.com',
  port: 465,
  secure: true,
  credentials: { username: 'sender@example.com', password: 'secret' },
  authType: ['plain' as const],
  responseTimeoutMs: 50,
}

describe('WorkerMailer hardening', () => {
  let mockSocket: any
  let mockReader: any
  let mockWriter: any
  const written = () =>
    mockWriter.write.mock.calls
      .map(([chunk]: [Uint8Array]) => new TextDecoder().decode(chunk))
      .join('')

  beforeEach(() => {
    vi.clearAllMocks()
    mockReader = { read: vi.fn(), releaseLock: vi.fn() }
    mockWriter = { write: vi.fn(), releaseLock: vi.fn() }
    mockSocket = {
      readable: { getReader: () => mockReader },
      writable: { getWriter: () => mockWriter },
      opened: Promise.resolve(),
      close: vi.fn(async () => {}),
      startTls: vi.fn(),
    }
    ;(connect as any).mockReturnValue(mockSocket)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('fails at once when the server closes the connection, and closes the socket', async () => {
    mockReader.read
      .mockResolvedValueOnce(line('220 smtp.example.com ready\r\n'))
      .mockResolvedValue({ done: true, value: undefined })

    await expect(WorkerMailer.connect(OPTIONS)).rejects.toThrow(
      /closed the connection/,
    )
    // Not a busy loop: one read for the greeting, one that saw the end.
    expect(mockReader.read).toHaveBeenCalledTimes(2)
    expect(mockSocket.close).toHaveBeenCalledOnce()
  })

  it('closes the socket when connecting fails before an instance is returned', async () => {
    mockReader.read
      .mockResolvedValueOnce(SIGNED_IN[0])
      .mockResolvedValueOnce(SIGNED_IN[1])
      .mockResolvedValueOnce(line('535 Authentication failed\r\n'))

    await expect(WorkerMailer.connect(OPTIONS)).rejects.toThrow(/authentication/)
    expect(mockSocket.close).toHaveBeenCalledOnce()
  })

  it('closes the socket when QUIT gets no answer, and closes only once', async () => {
    mockReader.read
      .mockResolvedValueOnce(SIGNED_IN[0])
      .mockResolvedValueOnce(SIGNED_IN[1])
      .mockResolvedValueOnce(SIGNED_IN[2])
      .mockImplementation(() => new Promise(() => {}))
    const mailer = await WorkerMailer.connect(OPTIONS)

    await Promise.all([mailer.close(), mailer.close()])

    expect(written().match(/QUIT/g)).toHaveLength(1)
    expect(mockSocket.close).toHaveBeenCalledOnce()
  })

  it('finishes RSET before reporting a refused recipient, and logs no address', async () => {
    const logs = [
      vi.spyOn(console, 'error').mockImplementation(() => {}),
      vi.spyOn(console, 'warn').mockImplementation(() => {}),
      vi.spyOn(console, 'info').mockImplementation(() => {}),
      vi.spyOn(console, 'log').mockImplementation(() => {}),
      vi.spyOn(console, 'debug').mockImplementation(() => {}),
    ]
    mockReader.read
      .mockResolvedValueOnce(SIGNED_IN[0])
      .mockResolvedValueOnce(SIGNED_IN[1])
      .mockResolvedValueOnce(SIGNED_IN[2])
      .mockResolvedValueOnce(line('250 OK\r\n')) // MAIL FROM
      .mockResolvedValueOnce(line('550 5.1.1 <nobody@example.com> unknown user\r\n')) // RCPT TO
      .mockResolvedValueOnce(line('250 Reset\r\n')) // RSET
      .mockResolvedValueOnce(line('221 Bye\r\n')) // QUIT
    const mailer = await WorkerMailer.connect(OPTIONS)

    let writtenWhenRejected = ''
    await mailer
      .send({
        from: 'sender@example.com',
        to: 'nobody@example.com',
        subject: 'Hi',
        text: 'Hi',
      })
      .catch(() => {
        writtenWhenRejected = written()
      })
    await mailer.close()

    expect(writtenWhenRejected).toMatch(/RSET\r\n$/)
    expect(written()).toMatch(/RSET\r\nQUIT\r\n$/)
    const logged = logs.flatMap(spy => spy.mock.calls.flat()).join(' ')
    expect(logged).toContain('Failed to send email')
    expect(logged).not.toContain('nobody@example.com')
  })
})

describe('Email input validation', () => {
  const base = {
    from: 'sender@example.com',
    to: 'recipient@example.com',
    subject: 'Hello',
    text: 'Hi',
  }

  it('refuses line breaks wherever they would reach a header or a command', () => {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ subject: 'Hello\r\nX-Injected: yes' }, /subject/],
      [{ to: 'victim@example.com>\r\nRCPT TO:<other@example.com' }, /address in to/],
      [{ to: 'a b@example.com' }, /address in to/],
      [{ to: 'no-at-sign' }, /address in to/],
      [{ from: { name: 'Evil\r\nBcc: x@example.com', email: 'sender@example.com' } }, /display name in from/],
      [{ cc: 'cc@example.com\nX: y' }, /address in cc/],
      [{ bcc: '<bcc@example.com>' }, /address in bcc/],
      [{ reply: 'reply@example.com\r\n' }, /address in reply/],
      [{ headers: { 'X-Note': 'ok\r\nX-Injected: yes' } }, /header X-Note/],
      [{ headers: { 'Bad:Name': 'v' } }, /header name/],
      [{ attachments: [{ filename: 'a"b.txt', content: 'aGk=' }] }, /quotes/],
      [{ attachments: [{ filename: 'a\r\nb.txt', content: 'aGk=' }] }, /attachment filename/],
      [{ to: [] }, /recipient/],
    ]
    for (const [override, message] of cases) {
      expect(() => new Email({ ...base, ...override } as any), JSON.stringify(override)).toThrow(message)
    }
  })

  it('escapes quotes in an ASCII display name and leaves an encoded one unquoted', () => {
    expect(formatAddress({ name: 'Ann "The" Smith\\', email: 'ann@example.com' })).toBe(
      '"Ann \\"The\\" Smith\\\\" <ann@example.com>',
    )
    expect(formatAddress({ name: 'Анна', email: 'anna@example.com' })).toMatch(
      /^=\?UTF-8\?Q\?[^"]+\?= <anna@example\.com>$/,
    )
    expect(formatAddress({ email: 'plain@example.com' })).toBe('plain@example.com')
  })

  it('accepts an ordinary email', () => {
    expect(() => new Email({ ...base, cc: 'cc@example.com', reply: 'r@example.com' })).not.toThrow()
  })
})
