# worker-mailer

## 1.4.3 (fork: @maxceem/worker-mailer)

### Patch Changes

- With no `dsn.NOTIFY` configured, RCPT TO carries no `NOTIFY` parameter, so a server that supports DSN applies its default and reports failures and delays to the sender. It used to write `NOTIFY=NEVER`, which asked for no bounces at all. `NOTIFY=NEVER` is now written only when every notification is explicitly turned off.
- `MAIL FROM` no longer ends with a stray space when no `RET` is configured.

## 1.4.2 (fork: @maxceem/worker-mailer)

### Patch Changes

- Each EHLO answer replaces the capabilities an earlier one advertised, as RFC 3207 requires after STARTTLS. Previously a sign-in method offered only before encryption could still be chosen afterwards and refused by the server.

## 1.4.1 (fork: @maxceem/worker-mailer)

### Patch Changes

- A custom BCC header is dropped in any letter case (`bcc`, `bCc`), not only `BCC` and `Bcc`.
- Writes time out after `socketTimeoutMs` and close the socket, so a server that stops draining can no longer hold a send, a connect or a close forever.
- A `close()` that arrives while a command is in flight drops the socket instead of writing `QUIT`, which would have read the reply meant for that command; the email in flight is still rejected.
- `send()` after `close()`, or after the connection failed, rejects at once instead of never settling; an email dequeued after shutdown is rejected too.

## 1.4.0 (fork: @maxceem/worker-mailer)

### Minor Changes

- Refuse input that would inject SMTP commands or headers: addresses must be `local@domain` without whitespace, control characters or `<>()[],;:"\`; display names, the subject, header values, attachment names and MIME types must not contain line breaks or control characters; header names must be valid. The `Email` constructor throws instead of sending.
- Never write a `BCC` header: blind copies go in the SMTP envelope only. Previously every recipient could see them.
- Quote ASCII display names safely (escaping `"` and `\`), and write encoded non-ASCII names without quotes, as RFC 2047 requires. Exported as `formatAddress`.
- Failed sends are logged at error level without their details, which quote addresses and server replies; the details stay at debug level, and the error still reaches the caller. The mail loop no longer logs through `console.error` regardless of `logLevel`.

### Patch Changes

- Reading stops when the server closes the connection, instead of spinning on end-of-stream until the timeout.
- The socket is closed when connecting fails, when a reply times out, and when `QUIT` gets no answer. `close()` is idempotent: concurrent calls share one shutdown.
- After a refused email, `RSET` completes before the send is rejected, so a caller that closes as soon as its send fails no longer talks over the reset.
- `WorkerMailer.send` closes the connection when the send fails.
- `envelopeId` must be valid xtext.

## 1.3.0 (fork: @maxceem/worker-mailer)

### Minor Changes

- Refuse to authenticate over an unencrypted connection. With `startTls` (the default) and a server that does not offer STARTTLS, the client used to continue in the clear and send the credentials anyway, so anything able to strip STARTTLS from the server's answer could read the password. It now throws before sending them, unless the connection is `secure` or the upgrade completed. `allowPlaintextAuth: true` restores the old behaviour.

### Patch Changes

- `responseTimeoutMs` is honoured; it was read from `socketTimeoutMs`.

## 1.2.1

### Patch Changes

- 18cd709: fix: implement SMTP dot-stuffing (rfc 5321)

## 1.2.0

### Minor Changes

- f3a7fb2: Implement quoted-printable encoding

## 1.1.5

### Patch Changes

- 02cc185: fix: Email headers override

## 1.1.4

### Patch Changes

- 159934d: fix: Mime boundary length too long.

## 1.1.3

### Patch Changes

- 55259f1: fix: Socket close timeout by ignoring promise result
- c385ba1: fix #23: some servers replied 550 MIME boundary length exceeded (see RFC 2046) to messages that were too long

## 1.1.2

### Patch Changes

- cb77d2b: fix: Socket close timeout by ignoring promise result
- 90d0631: fix #23: some servers replied 550 MIME boundary length exceeded (see RFC 2046) to messages that were too long

## 1.1.1

### Patch Changes

- e14a156: fix: Add missing space before NOTIFY=NEVER

## 1.1.0

### Minor Changes

- 15a2961: Add DSN & attachment features
- 15a2961: Add startTls options(default: true), upgrade to TLS if SMTP server supported.

## 1.0.1

### Patch Changes

- 248bb4a: Export LogLevel Enum while packaging
