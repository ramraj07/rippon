# App Privacy (the "nutrition label")

App Store Connect → App Privacy. Apple counts data as **collected** only when it leaves the device
and the developer (or a partner of theirs) can get at it. Rippon sends data only to the SSH servers
and web sites the user chooses, never to the developer, so the answer is **Data Not Collected**.

## Answers

1. **Do you or your third-party partners collect data from this app?** → **No, we do not collect
   data from this app.**

That's the whole questionnaire; the label then reads "Data Not Collected".

**Privacy Policy URL:** see [listing.md](listing.md#privacy-policy-url-required).

## Why that's accurate (checked against the code)

| Data | Where it goes | Collected? |
|---|---|---|
| Host names, users, ports, port forwards | App's own storage on the phone (`Application Support`) | No, stays on device |
| SSH private keys and passwords | iOS Keychain, `AfterFirstUnlockThisDeviceOnly` (not synced, not in backups to other devices) | No |
| Trusted host keys, key list, key bar layout, settings | `UserDefaults` on the phone | No |
| Layout, per-session pages, bookmarks | A profile file on **the user's own server** (`~/.rippon/profiles/`) | No, the developer can't reach it |
| Terminal output, files browsed | Streamed from the user's server over SSH, shown, not stored (downloads go to the share sheet) | No |
| Pages opened in the in-app browser | WebKit, with its cookies and cache in the app's sandbox | No (the sites the user visits are their own business, as in Safari) |
| Analytics, crash reporting, ads, tracking SDKs | None in the app. Dependencies are Citadel, SwiftTerm, SwiftNIO, swift-crypto and BigInt; none phone home | No |

Apple's own crash reports and App Store analytics, shared only by users who opt in, are not
counted as collection by the developer.

**Keep it true:** adding any analytics, crash reporter (Sentry, Firebase…), remote config or
sign-in later means updating this label *before* that build ships.

## Privacy manifest

`ios/Rippon/PrivacyInfo.xcprivacy` (added with these docs) declares: no tracking, no collected
data, and the one "required reason" API the app uses, `UserDefaults` (reason `CA92.1`, data only
the app itself reads). Apple warns on upload (ITMS-91053) when an app uses these APIs without one.
