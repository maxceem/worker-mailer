import { connect } from 'cloudflare:sockets'
import { BlockingQueue, decode, encode, execTimeout } from './utils'
import { Email, EmailOptions } from './email'
import Logger, { LogLevel } from './logger'

export type AuthType = 'plain' | 'login' | 'cram-md5'
export type Credentials = {
  username: string
  password: string
}
export type WorkerMailerOptions = {
  host: string
  port: number
  secure?: boolean
  startTls?: boolean
  /**
   * Send credentials over a connection that is not encrypted. Off by default:
   * unless the connection is TLS from the start (`secure`) or the server
   * completed a STARTTLS upgrade, the client refuses to authenticate rather
   * than send the password in the clear. Without this, a server, or anything
   * between it and the Worker, that leaves STARTTLS out of its EHLO answer
   * would receive the credentials unencrypted.
   */
  allowPlaintextAuth?: boolean
  credentials?: Credentials
  authType?: AuthType | AuthType[]
  logLevel?: LogLevel
  dsn?:
    | {
        RET?:
          | {
              HEADERS?: boolean
              FULL?: boolean
            }
          | undefined
        NOTIFY?:
          | {
              DELAY?: boolean
              FAILURE?: boolean
              SUCCESS?: boolean
            }
          | undefined
      }
    | undefined
  socketTimeoutMs?: number
  responseTimeoutMs?: number
}

export class WorkerMailer {
  private socket: Socket

  private readonly host: string
  private readonly port: number
  private readonly secure: boolean
  private readonly startTls: boolean
  private readonly allowPlaintextAuth: boolean
  /** Whether the connection is encrypted: TLS from the start, or after STARTTLS. */
  private encrypted: boolean
  private readonly authType: AuthType[]
  private readonly credentials?: Credentials

  private readonly socketTimeoutMs: number
  private readonly responseTimeoutMs: number

  private reader: ReadableStreamDefaultReader<Uint8Array>
  private writer: WritableStreamDefaultWriter<Uint8Array>

  private readonly logger: Logger

  private readonly dsn:
    | {
        envelopeId?: string | undefined
        RET?:
          | {
              HEADERS?: boolean
              FULL?: boolean
            }
          | undefined
        NOTIFY?:
          | {
              DELAY?: boolean
              FAILURE?: boolean
              SUCCESS?: boolean
            }
          | undefined
      }
    | undefined

  private readonly sendNotificationsTo: string | undefined

  private active = false
  /** The one shutdown in progress, so a second `close` waits for it instead of racing it. */
  private closing: Promise<void> | null = null
  private socketClosed = false

  private emailSending: Email | null = null
  private emailToBeSent = new BlockingQueue<Email>()

  /** SMTP server capabilities **/
  private supportsDSN = false
  private allowAuth = false
  private authTypeSupported: AuthType[] = []
  private supportsStartTls = false

  private constructor(options: WorkerMailerOptions) {
    this.port = options.port
    this.host = options.host
    this.secure = !!options.secure
    if (Array.isArray(options.authType)) {
      this.authType = options.authType
    } else if (typeof options.authType === 'string') {
      this.authType = [options.authType]
    } else {
      this.authType = []
    }
    this.startTls = options.startTls === undefined ? true : options.startTls
    this.allowPlaintextAuth = options.allowPlaintextAuth ?? false
    this.encrypted = this.secure
    this.credentials = options.credentials
    this.dsn = options.dsn || {}

    this.socketTimeoutMs = options.socketTimeoutMs || 60_000
    this.responseTimeoutMs = options.responseTimeoutMs || 30_000
    this.socket = connect(
      {
        hostname: this.host,
        port: this.port,
      },
      {
        secureTransport: this.secure
          ? 'on'
          : this.startTls
            ? 'starttls'
            : 'off',
        allowHalfOpen: false,
      },
    )
    this.reader = this.socket.readable.getReader()
    this.writer = this.socket.writable.getWriter()

    this.logger = new Logger(
      options.logLevel,
      `[WorkerMailer:${this.host}:${this.port}]`,
    )
  }

  static async connect(options: WorkerMailerOptions): Promise<WorkerMailer> {
    const mailer = new WorkerMailer(options)
    try {
      await mailer.initializeSmtpSession()
    } catch (error) {
      // The caller never gets an instance to close, so the socket is closed here.
      mailer.closeSocket()
      throw error
    }
    mailer.start().catch((error: unknown) => {
      mailer.logger.error('Mail loop stopped')
      mailer.logger.debug(
        'Mail loop stopped: ' +
          (error instanceof Error ? error.message : String(error)),
      )
    })
    return mailer
  }

  public send(options: EmailOptions): Promise<void> {
    const email = new Email(options)
    this.emailToBeSent.enqueue(email)
    return email.sent
  }

  static async send(
    options: WorkerMailerOptions,
    email: EmailOptions,
  ): Promise<void> {
    const mailer = await WorkerMailer.connect(options)
    try {
      await mailer.send(email)
    } finally {
      await mailer.close()
    }
  }

  private async readTimeout(): Promise<string> {
    try {
      return await execTimeout(
        this.read(),
        this.responseTimeoutMs,
        new Error('Timeout while waiting for smtp server response'),
      )
    } catch (error) {
      // A read that lost the race would otherwise stay pending on a socket
      // nobody will answer on; closing it ends that read too.
      this.closeSocket()
      throw error
    }
  }

  private async read(): Promise<string> {
    let response = ''
    while (true) {
      const { value, done } = await this.reader.read()
      if (done) {
        throw new Error('SMTP server closed the connection')
      }
      if (!value) {
        continue
      }
      const data = decode(value).toString()
      this.logger.debug('SMTP server response:\n' + data)
      response = response + data
      if (!response.endsWith('\n')) {
        continue
      }
      const lines = response.split(/\r?\n/)
      const lastLine = lines[lines.length - 2]
      if (/^\d+-/.test(lastLine)) {
        continue
      }
      return response
    }
  }

  private async writeLine(line: string) {
    await this.write(`${line}\r\n`)
  }

  private async write(data: string) {
    this.logger.debug('Write to socket:\n' + data)
    await this.writer.write(encode(data))
  }

  private async initializeSmtpSession() {
    await this.waitForSocketConnected()
    await this.greet()
    await this.ehlo()

    // Handle STARTTLS if needed
    if (this.startTls && !this.secure && this.supportsStartTls) {
      await this.tls()
      // Re-issue EHLO after STARTTLS as required by RFC 3207
      await this.ehlo()
    }

    if (this.credentials && !this.encrypted && !this.allowPlaintextAuth) {
      throw new Error(
        'Refusing to send credentials over an unencrypted connection: the server did not offer STARTTLS. ' +
          'Connect with `secure: true` (usually port 465), or set `allowPlaintextAuth` to accept the risk.',
      )
    }

    await this.auth()
    this.active = true
  }

  private async start() {
    while (this.active) {
      this.emailSending = await this.emailToBeSent.dequeue()
      try {
        await this.mail()
        await this.rcpt()
        await this.data()
        await this.body()
        this.emailSending!.setSent()
      } catch (e: any) {
        // The error goes to the caller through `sent`; it quotes addresses and
        // server replies, so only debug logging repeats it.
        this.logger.error('Failed to send email')
        this.logger.debug('Failed to send email: ' + e.message)
        const failed = this.emailSending!
        this.emailSending = null
        if (!this.active) {
          failed.setSentError(e)
          return
        }
        // Recover before telling the caller, so a caller that closes as soon
        // as its send fails never talks over the RSET exchange.
        try {
          await this.rset()
        } catch (resetError: any) {
          await this.close(resetError)
          failed.setSentError(e)
          return
        }
        failed.setSentError(e)
        continue
      }
      this.emailSending = null
    }
  }

  public close(error?: Error): Promise<void> {
    this.closing ??= this.shutdown(error)
    return this.closing
  }

  private async shutdown(error?: Error) {
    this.active = false
    this.logger.info('WorkerMailer is closed')
    if (error) this.logger.debug('WorkerMailer closed after: ' + error.message)
    this.emailSending?.setSentError?.(
      error || new Error('WorkerMailer is shutting down'),
    )
    while (this.emailToBeSent.length) {
      const email = await this.emailToBeSent.dequeue()
      email.setSentError(error || new Error('WorkerMailer is shutting down'))
    }

    try {
      if (!this.socketClosed) {
        await this.writeLine('QUIT')
        await this.readTimeout()
      }
    } catch (ignore) {
      // The server may already have closed it; either way it is closed below.
    } finally {
      this.closeSocket()
    }
  }

  /**
   * Closes the socket once, without waiting: a server that closed its side
   * first never settles the close, so it is fire and forget.
   */
  private closeSocket() {
    if (this.socketClosed) return
    this.socketClosed = true
    try {
      void Promise.resolve(this.socket.close()).catch(() => {})
    } catch {
      // Already closed.
    }
  }

  private async waitForSocketConnected() {
    this.logger.info(`Connecting to SMTP server`)
    await execTimeout(
      this.socket.opened,
      this.socketTimeoutMs,
      new Error('Socket timeout!'),
    )
    this.logger.info('SMTP server connected')
  }

  private async greet() {
    const response = await this.readTimeout()
    if (!response.startsWith('220')) {
      throw new Error('Failed to connect to SMTP server: ' + response)
    }
  }

  private async ehlo() {
    await this.writeLine(`EHLO 127.0.0.1`)
    const response = await this.readTimeout()
    if (response.startsWith('421')) {
      throw new Error(`Failed to EHLO. ${response}`)
    }
    if (!response.startsWith('2')) {
      // falling back to HELO
      await this.helo()
      return
    }
    this.parseCapabilities(response)
  }

  private async helo() {
    await this.writeLine(`HELO 127.0.0.1`)
    const response = await this.readTimeout()
    if (response.startsWith('2')) {
      return
    }
    throw new Error(`Failed to HELO. ${response}`)
  }

  private async tls() {
    await this.writeLine('STARTTLS')
    const response = await this.readTimeout()
    if (!response.startsWith('220')) {
      throw new Error('Failed to start TLS: ' + response)
    }

    // Upgrade the socket to TLS
    this.reader.releaseLock()
    this.writer.releaseLock()
    this.socket = this.socket.startTls()
    this.reader = this.socket.readable.getReader()
    this.writer = this.socket.writable.getWriter()
    this.encrypted = true
  }

  private parseCapabilities(response: string) {
    if (/[ -]AUTH\b/i.test(response)) {
      this.allowAuth = true
    }
    if (/[ -]AUTH(?:(\s+|=)[^\n]*\s+|\s+|=)PLAIN/i.test(response)) {
      this.authTypeSupported.push('plain')
    }
    if (/[ -]AUTH(?:(\s+|=)[^\n]*\s+|\s+|=)LOGIN/i.test(response)) {
      this.authTypeSupported.push('login')
    }
    if (/[ -]AUTH(?:(\s+|=)[^\n]*\s+|\s+|=)CRAM-MD5/i.test(response)) {
      this.authTypeSupported.push('cram-md5')
    }
    if (/[ -]STARTTLS\b/i.test(response)) {
      this.supportsStartTls = true
    }
    if (/[ -]DSN\b/i.test(response)) {
      this.supportsDSN = true
    }
  }

  private async auth() {
    if (!this.allowAuth) {
      return
    }
    if (!this.credentials) {
      throw new Error(
        'smtp server requires authentication, but no credentials found',
      )
    }
    if (
      this.authTypeSupported.includes('plain') &&
      this.authType.includes('plain')
    ) {
      await this.authWithPlain()
    } else if (
      this.authTypeSupported.includes('login') &&
      this.authType.includes('login')
    ) {
      await this.authWithLogin()
    } else if (
      this.authTypeSupported.includes('cram-md5') &&
      this.authType.includes('cram-md5')
    ) {
      await this.authWithCramMD5()
    } else {
      throw new Error('No supported auth method found.')
    }
  }

  private async authWithPlain() {
    const userPassBase64 = btoa(
      `\u0000${this.credentials!.username}\u0000${this.credentials!.password}`,
    )
    await this.writeLine(`AUTH PLAIN ${userPassBase64}`)
    const authResult = await this.readTimeout()
    if (!authResult.startsWith('2')) {
      throw new Error(`Failed to plain authentication: ${authResult}`)
    }
  }

  private async authWithLogin() {
    await this.writeLine(`AUTH LOGIN`)
    const startLoginResponse = await this.readTimeout()
    if (!startLoginResponse.startsWith('3')) {
      throw new Error('Invalid login: ' + startLoginResponse)
    }

    const usernameBase64 = btoa(this.credentials!.username)
    await this.writeLine(usernameBase64)
    const userResponse = await this.readTimeout()
    if (!userResponse.startsWith('3')) {
      throw new Error('Failed to login authentication: ' + userResponse)
    }

    const passwordBase64 = btoa(this.credentials!.password)
    await this.writeLine(passwordBase64)
    const authResult = await this.readTimeout()
    if (!authResult.startsWith('2')) {
      throw new Error('Failed to login authentication: ' + authResult)
    }
  }

  private async authWithCramMD5() {
    await this.writeLine('AUTH CRAM-MD5')
    const challengeResponse = await this.readTimeout()
    const challengeWithBase64Encoded = challengeResponse
      .match(/^334\s+(.+)$/)
      ?.pop()
    if (!challengeWithBase64Encoded) {
      throw new Error('Invalid CRAM-MD5 challenge: ' + challengeResponse)
    }

    // solve challenge
    const challenge = atob(challengeWithBase64Encoded)

    // Import password as key
    const keyData = encode(this.credentials!.password)
    const key = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: 'MD5' },
      false,
      ['sign'],
    )

    // Sign the challenge
    const challengeData = encode(challenge)
    const signature = await crypto.subtle.sign('HMAC', key, challengeData)

    // Convert to hex
    const challengeSolved = Array.from(new Uint8Array(signature))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')

    await this.writeLine(
      btoa(`${this.credentials!.username} ${challengeSolved}`),
    )
    const authResult = await this.readTimeout()
    if (!authResult.startsWith('2')) {
      throw new Error('Failed to cram-md5 authentication: ' + authResult)
    }
  }

  private async mail() {
    let message = `MAIL FROM: <${this.emailSending!.from.email}>`
    if (this.supportsDSN) {
      message += ` ${this.retBuilder()}`
      const envelopeId = this.emailSending?.dsnOverride?.envelopeId
      if (envelopeId) {
        if (!/^[!-~]+$/.test(envelopeId) || /[+=]/.test(envelopeId)) {
          throw new Error('envelopeId must be printable ASCII without spaces, "+" or "="')
        }
        message += ` ENVID=${envelopeId}`
      }
    }

    await this.writeLine(message)
    const response = await this.readTimeout()
    if (!response.startsWith('2')) {
      throw new Error(`Invalid ${message} ${response}`)
    }
  }

  private async rcpt() {
    const allRecipients = [
      ...this.emailSending!.to,
      ...(this.emailSending!.cc || []),
      ...(this.emailSending!.bcc || []),
    ]

    for (let user of allRecipients) {
      let message = `RCPT TO: <${user.email}>`
      if (this.supportsDSN) {
        message += this.notificationBuilder()
      }
      await this.writeLine(message)
      const rcptResponse = await this.readTimeout()
      if (!rcptResponse.startsWith('2')) {
        throw new Error(`Invalid ${message} ${rcptResponse}`)
      }
    }
  }

  private async data() {
    await this.writeLine('DATA')
    const response = await this.readTimeout()
    if (!response.startsWith('3')) {
      throw new Error(`Failed to send DATA: ${response}`)
    }
  }

  private async body() {
    await this.write(this.emailSending!.getEmailData())
    const response = await this.readTimeout()
    if (!response.startsWith('2')) {
      throw new Error('Failed send email body: ' + response)
    }
  }

  private async rset() {
    await this.writeLine('RSET')
    const response = await this.readTimeout()
    if (!response.startsWith('2')) {
      throw new Error(`Failed to reset: ${response}`)
    }
  }

  private notificationBuilder() {
    const notifications: string[] = []
    if (
      (this.emailSending?.dsnOverride?.NOTIFY &&
        this.emailSending?.dsnOverride?.NOTIFY?.SUCCESS) ||
      (!this.emailSending?.dsnOverride?.NOTIFY && this.dsn?.NOTIFY?.SUCCESS)
    ) {
      notifications.push('SUCCESS')
    }
    if (
      (this.emailSending?.dsnOverride?.NOTIFY &&
        this.emailSending?.dsnOverride?.NOTIFY?.FAILURE) ||
      (!this.emailSending?.dsnOverride?.NOTIFY && this.dsn?.NOTIFY?.FAILURE)
    ) {
      notifications.push('FAILURE')
    }
    if (
      (this.emailSending?.dsnOverride?.NOTIFY &&
        this.emailSending?.dsnOverride?.NOTIFY?.DELAY) ||
      (!this.emailSending?.dsnOverride?.NOTIFY && this.dsn?.NOTIFY?.DELAY)
    ) {
      notifications.push('DELAY')
    }
    return notifications.length > 0
      ? ` NOTIFY=${notifications.join(',')}`
      : ' NOTIFY=NEVER'
  }

  private retBuilder() {
    const ret: string[] = []
    if (
      (this.emailSending?.dsnOverride?.RET &&
        this.emailSending?.dsnOverride?.RET?.HEADERS) ||
      (!this.emailSending?.dsnOverride?.RET && this.dsn?.RET?.HEADERS)
    ) {
      ret.push('HDRS')
    }
    if (
      (this.emailSending?.dsnOverride?.RET &&
        this.emailSending?.dsnOverride?.RET?.FULL) ||
      (!this.emailSending?.dsnOverride?.RET && this.dsn?.RET?.FULL)
    ) {
      ret.push('FULL')
    }
    return ret.length > 0 ? `RET=${ret.join(',')}` : ''
  }
}
