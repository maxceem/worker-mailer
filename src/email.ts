import { encode, encodeQuotedPrintable } from './utils'

export function encodeHeader(text: string): string {
  // If the text contains any non-ASCII characters, encode the whole string
  if (!/[^\x00-\x7F]/.test(text)) {
    return text
  }
  const bytes = encode(text)
  let encoded = ''

  for (const byte of bytes) {
    // RFC 2047 specific rules for headers:
    // - Printable ASCII except ?, =, _, and space
    // - Space becomes underscore
    if (
      byte >= 33 &&
      byte <= 126 &&
      byte !== 63 &&
      byte !== 61 &&
      byte !== 95
    ) {
      // 63 = '?', 61 = '=', 95 = '_'
      encoded += String.fromCharCode(byte)
    } else if (byte === 32) {
      // Space becomes underscore in headers (RFC 2047)
      encoded += '_'
    } else {
      // Encode everything else
      encoded += `=${byte.toString(16).toUpperCase().padStart(2, '0')}`
    }
  }

  return `=?UTF-8?Q?${encoded}?=`
}

export type User = { name?: string; email: string }

/**
 * An address as it may appear in an SMTP command and a header: something@
 * something, with no whitespace, control characters, angle brackets or other
 * characters that would end the `<...>` it is written in. Anything else could
 * add a command or a header, so it is refused rather than escaped.
 */
const ADDRESS = /^[^\s<>()[\],;:"\\@\x00-\x1f\x7f]+@[^\s<>()[\],;:"\\@\x00-\x1f\x7f]+$/

/** A line break or any other control character, which would end a header line. */
const CONTROL = /[\x00-\x08\x0a-\x1f\x7f]/

/** A header name: printable ASCII without a colon (RFC 5322). */
const HEADER_NAME = /^[!-9;-~]+$/

function checkAddress(user: User, field: string): User {
  if (typeof user.email !== 'string' || !ADDRESS.test(user.email)) {
    throw new Error(`Invalid email address in ${field}`)
  }
  if (user.name !== undefined && CONTROL.test(user.name)) {
    throw new Error(`Invalid display name in ${field}: control characters are not allowed`)
  }
  return user
}

function checkText(value: string, field: string): string {
  if (CONTROL.test(value)) {
    throw new Error(`Invalid ${field}: control characters are not allowed`)
  }
  return value
}

/**
 * `"Name" <address>` for an ASCII name, with quotes and backslashes escaped;
 * an encoded word outside quotes for any other, since RFC 2047 does not allow
 * one inside a quoted string.
 */
export function formatAddress(user: User): string {
  if (!user.name) return user.email
  const encoded = encodeHeader(user.name)
  if (encoded !== user.name) return `${encoded} <${user.email}>`
  return `"${user.name.replace(/[\\"]/g, '\\$&')}" <${user.email}>`
}

export type EmailOptions = {
  from: string | User
  to: string | string[] | User | User[]
  reply?: string | User
  cc?: string | string[] | User | User[]
  bcc?: string | string[] | User | User[]
  subject: string
  text?: string
  html?: string
  headers?: Record<string, string>
  attachments?: { filename: string; content: string; mimeType?: string }[]
  dsnOverride?: {
    envelopeId?: string
    RET?: {
      HEADERS?: boolean
      FULL?: boolean
    }
    NOTIFY?: {
      DELAY?: boolean
      FAILURE?: boolean
      SUCCESS?: boolean
    }
  }
}

export class Email {
  public readonly from: User
  public readonly to: User[]
  public readonly reply?: User
  public readonly cc?: User[]
  public readonly bcc?: User[]

  public readonly subject: string
  public readonly text?: string
  public readonly html?: string
  public readonly dsnOverride?: {
    envelopeId?: string
    RET?: {
      HEADERS?: boolean
      FULL?: boolean
    }
    NOTIFY?: {
      DELAY?: boolean
      FAILURE?: boolean
      SUCCESS?: boolean
    }
  }

  public readonly attachments?: {
    filename: string
    content: string
    mimeType?: string
  }[]

  public readonly headers: Record<string, string>

  public setSent!: () => void
  public setSentError!: (e: unknown) => void
  public sent = new Promise<void>((resolve, reject) => {
    this.setSent = resolve
    this.setSentError = reject
  })

  constructor(options: EmailOptions) {
    if (!options.text && !options.html) {
      throw new Error('At least one of text or html must be provided')
    }

    if (typeof options.from === 'string') {
      this.from = { email: options.from }
    } else {
      this.from = options.from
    }
    if (typeof options.reply === 'string') {
      this.reply = { email: options.reply }
    } else {
      this.reply = options.reply
    }
    this.to = Email.toUsers(options.to)!
    this.cc = Email.toUsers(options.cc)
    this.bcc = Email.toUsers(options.bcc)

    this.subject = options.subject
    this.text = options.text
    this.html = options.html
    this.attachments = options.attachments
    this.dsnOverride = options.dsnOverride
    this.headers = options.headers || {}
    this.validate()
  }

  /**
   * Refuses anything that would reach the SMTP conversation or a header line
   * with a line break in it: addresses, display names, the subject, header
   * names and values, and attachment names. Bodies are encoded, so they may
   * contain anything.
   */
  private validate() {
    if (!this.to?.length) throw new Error('At least one recipient is required')
    checkAddress(this.from, 'from')
    if (this.reply) checkAddress(this.reply, 'reply')
    for (const [field, users] of [
      ['to', this.to],
      ['cc', this.cc],
      ['bcc', this.bcc],
    ] as const) {
      for (const user of users ?? []) checkAddress(user, field)
    }
    checkText(this.subject ?? '', 'subject')
    for (const [name, value] of Object.entries(this.headers)) {
      if (!HEADER_NAME.test(name)) throw new Error('Invalid header name')
      checkText(String(value), `header ${name}`)
    }
    for (const attachment of this.attachments ?? []) {
      checkText(attachment.filename, 'attachment filename')
      if (attachment.filename.includes('"')) {
        throw new Error('Invalid attachment filename: quotes are not allowed')
      }
      if (attachment.mimeType !== undefined) {
        checkText(attachment.mimeType, 'attachment mimeType')
      }
    }
  }

  private static toUsers(
    user: string | string[] | User | User[] | undefined,
  ): User[] | undefined {
    if (!user) {
      return
    }
    if (typeof user === 'string') {
      return [{ email: user }]
    } else if (Array.isArray(user)) {
      return user.map(user => {
        if (typeof user === 'string') {
          return { email: user }
        }
        return user
      })
    } else {
      return [user]
    }
  }

  public getEmailData() {
    this.resolveHeader()

    const headersArray: string[] = ['MIME-Version: 1.0']
    for (const [key, value] of Object.entries(this.headers)) {
      headersArray.push(`${key}: ${value}`)
    }
    const mixedBoundary = this.generateSafeBoundary('mixed_')
    const alternativeBoundary = this.generateSafeBoundary('alternative_')

    headersArray.push(
      `Content-Type: multipart/mixed; boundary="${mixedBoundary}"`,
    )
    const headers = headersArray.join('\r\n')

    let emailData = `${headers}\r\n\r\n`
    emailData += `--${mixedBoundary}\r\n`

    emailData += `Content-Type: multipart/alternative; boundary="${alternativeBoundary}"\r\n\r\n`

    if (this.text) {
      emailData += `--${alternativeBoundary}\r\n`
      emailData += `Content-Type: text/plain; charset="UTF-8"\r\n`
      emailData += `Content-Transfer-Encoding: quoted-printable\r\n\r\n`
      const encodedText = encodeQuotedPrintable(this.text)
      emailData += `${encodedText}\r\n\r\n`
    }

    if (this.html) {
      emailData += `--${alternativeBoundary}\r\n`
      emailData += `Content-Type: text/html; charset="UTF-8"\r\n`
      emailData += `Content-Transfer-Encoding: quoted-printable\r\n\r\n`
      const encodedHtml = encodeQuotedPrintable(this.html)
      emailData += `${encodedHtml}\r\n\r\n`
    }

    emailData += `--${alternativeBoundary}--\r\n`

    if (this.attachments) {
      for (const attachment of this.attachments) {
        const mimeType =
          attachment.mimeType || this.getMimeType(attachment.filename)
        emailData += `--${mixedBoundary}\r\n`
        emailData += `Content-Type: ${mimeType}; name="${attachment.filename}"\r\n`
        emailData += `Content-Description: ${attachment.filename}\r\n`
        emailData += `Content-Disposition: attachment; filename="${attachment.filename}";\r\n`
        emailData += `    creation-date="${new Date().toUTCString()}";\r\n`
        emailData += `Content-Transfer-Encoding: base64\r\n\r\n`

        // split the content into multiple lines to avoid line length greater than 76 characters https://en.wikipedia.org/wiki/Base64#Variants_summary_table
        const lines = attachment.content.match(/.{1,72}/g)
        if (lines) {
          emailData += `${lines.join('\r\n')}`
        } else {
          emailData += `${attachment.content}`
        }
        emailData += '\r\n\r\n'
      }
    }
    emailData += `--${mixedBoundary}--\r\n`

    const safeEmailData = this.applyDotStuffing(emailData)

    return `${safeEmailData}\r\n.\r\n`
  }

  private applyDotStuffing(data: string): string {
    let result = data.replace(/\r\n\./g, '\r\n..')
    if (result.startsWith('.')) {
      result = `.${result}`
    }
    return result
  }

  private generateSafeBoundary(prefix: string): string {
    const bytes = new Uint8Array(28)
    crypto.getRandomValues(bytes)
    const hex = Array.from(bytes)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')

    let boundary = prefix + hex
    boundary = boundary.replace(/[<>@,;:\\/[\]?=" ]/g, '_') // Replace unwanted characters with '_'

    return boundary
  }

  private getMimeType(filename: string): string {
    const extension = filename.split('.').pop()?.toLowerCase()

    const mimeTypes: { [key: string]: string } = {
      txt: 'text/plain',
      html: 'text/html',
      csv: 'text/csv',
      pdf: 'application/pdf',
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      zip: 'application/zip',
    }

    return mimeTypes[extension || 'txt'] || 'application/octet-stream' // Default to 'application/octet-stream'
  }

  private resolveHeader() {
    this.resolveFrom()
    this.resolveTo()
    this.resolveReply()
    this.resolveCC()
    this.resolveBCC()
    this.resolveSubject()
    this.headers['Date'] = this.headers['Date'] ?? new Date().toUTCString()
    this.headers['Message-ID'] =
      this.headers['Message-ID'] ??
      `<${crypto.randomUUID()}@${this.from.email.split('@').pop()}>`
  }

  private resolveFrom() {
    if (this.headers['From']) {
      return
    }
    this.headers['From'] = formatAddress(this.from)
  }

  private resolveTo() {
    if (this.headers['To']) {
      return
    }
    const toAddresses = this.to.map(formatAddress)
    this.headers['To'] = toAddresses.join(', ')
  }

  private resolveSubject() {
    if (this.headers['Subject']) {
      return
    }
    if (this.subject) {
      this.headers['Subject'] = encodeHeader(this.subject)
    }
  }

  private resolveReply() {
    if (this.headers['Reply-To']) {
      return
    }
    if (this.reply) {
      this.headers['Reply-To'] = formatAddress(this.reply)
    }
  }

  private resolveCC() {
    if (this.headers['CC']) {
      return
    }
    if (this.cc) {
      const ccAddresses = this.cc.map(formatAddress)
      this.headers['CC'] = ccAddresses.join(', ')
    }
  }

  /**
   * Blind copies travel in the SMTP envelope alone (see `rcpt`): a `BCC`
   * header would show every recipient who else was copied.
   */
  private resolveBCC() {
    delete this.headers['BCC']
    delete this.headers['Bcc']
  }

}
