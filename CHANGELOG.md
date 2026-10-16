# worker-mailer

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
