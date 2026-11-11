# App Store submission kit

Everything needed to put Rippon on the App Store, ready to paste into App Store Connect.

| File | What it covers |
|---|---|
| [listing.md](listing.md) | Name, subtitle, promotional text, description, keywords, What's New, URLs, category, copyright |
| [app-review.md](app-review.md) | Sign-in details and notes for App Review, and how to run the test server they need |
| [demo-host-setup.sh](demo-host-setup.sh) | Sets up that test server on a fresh Ubuntu VM |
| [age-rating.md](age-rating.md) | Age rating questionnaire answers (result: 16+) |
| [app-privacy.md](app-privacy.md) | App Privacy label answers (result: Data Not Collected) and the privacy manifest |
| [privacy-policy.md](privacy-policy.md) | Privacy policy to publish at a public URL |
| [export-compliance.md](export-compliance.md) | Encryption questions (SSH counts) and the France question |
| [screenshots.md](screenshots.md) | Sizes, the six shots with captions, and how to capture them |
| [check_lengths.py](check_lengths.py) | Checks the listing text against Apple's character limits |

## What only you can do or decide

Marked **[YOU]** in the files. In rough order:

1. **Apple Developer Program** membership (paid) in the name you want shown as the seller.
2. **Create the app** in App Store Connect with bundle ID `dev.rippon.Rippon`; pick the
   **name** (check it's free) and **primary language** (English (U.S.)).
3. **Run the test server** for App Review and keep it up until approval
   ([app-review.md](app-review.md)). Without it the app will be rejected.
4. **Fill in the privacy policy**: contact email, your name, date. Merge it so its URL works.
5. **Contact details** for App Review (name, phone, email).
6. **Price and countries**, and whether to include France ([export-compliance.md](export-compliance.md)).
7. **iPad**: make iPad screenshots, or turn iPad off before the first upload
   ([screenshots.md](screenshots.md)).
8. **Version**: bump `MARKETING_VERSION` to `1.0.0` in `project.yml`.
9. **Screenshots** on the simulator against the test server.
10. **Archive and upload** from Xcode (Product → Archive → Distribute App → App Store Connect),
    which needs your distribution signing, then submit for review.

## Before submitting

- Merge the in-progress features (PR #9) first, or remove their lines from the description.
- Run `python3 ios/AppStore/check_lengths.py`.
- From a phone on **cellular** data (not your Wi-Fi), sign in to the test server with Rippon.
