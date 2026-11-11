# Export compliance (encryption)

Rippon encrypts data in transit with SSH, so it **does** use encryption, and Apple asks about it
for every build until the answers are saved.

Not legal advice: these are the answers that fit how the app is built. Check them against Apple's
[overview of export compliance](https://developer.apple.com/help/app-store-connect/manage-app-information/overview-of-export-compliance)
when you submit.

## What the app uses

- **SSH** (RFC 4251–4254, IETF standard) through [Citadel](https://github.com/orlandos-nl/Citadel)
  and SwiftNIO SSH: key exchange (curve25519 / ECDH), AES-GCM / AES-CTR, HMAC-SHA2.
- **swift-crypto** (Apple's open-source CryptoKit API; parts of it are BoringSSL compiled into the
  app) and Apple's Security framework for RSA signatures and the Keychain.
- **HTTPS** in the browser through WebKit, which is the operating system's.

These are all standard, published algorithms. None are proprietary. Part of the SSH encryption is
compiled into the app rather than coming from iOS, so the app does **not** qualify as "uses only
the encryption in Apple's operating system". It also isn't exempt as "authentication only": SSH
encrypts the whole session.

## Answers in App Store Connect

1. **Does your app use encryption?** → **Yes.**
2. **Does your app qualify for any of the exemptions…?** → **No.**
3. **What type of encryption algorithms does your app implement?** →
   **Standard encryption algorithms instead of, or in addition to, using or accessing the
   encryption within Apple's operating system.**
4. **Is your app going to be available on the App Store in France?**
   - **[YOU] No (recommended for the first release):** nothing else to upload.
   - **Yes:** Apple then requires the French encryption declaration (ANSSI), which you file
     yourself and upload. It can take weeks. You can add France in a later update once you have
     it.

Under US rules (EAR §740.17(b)(1), "mass market"), a free SSH client using standard algorithms
needs no CCATS. Apple only asks for a CCATS for proprietary algorithms.

## Stop being asked on every build (optional)

Once Apple accepts the answers it shows an export compliance code for the app. Adding it to
`project.yml` under `info.properties` skips the question on later uploads:

```yaml
ITSAppUsesNonExemptEncryption: true
ITSEncryptionExportComplianceCode: <code from App Store Connect>
```

Don't add `ITSAppUsesNonExemptEncryption: false`: that would be a wrong declaration.
