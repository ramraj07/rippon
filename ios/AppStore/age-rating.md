# Age rating

App Store Connect → App Information → Age Rating. Answers for Apple's current questionnaire
(the one introduced in 2025, with 4+, 9+, 13+, 16+ and 18+).

| Question | Answer | Why |
|---|---|---|
| Parental controls (in-app controls) | No | |
| Age assurance (in-app controls) | No | |
| Unrestricted web access | **Yes** | Each session has a browser that can open any address the user types or taps. |
| User-generated content | No | Nothing is shared between users; the app shows the user's own servers. |
| Messaging and chat | No | |
| Advertising | No | |
| Social media | No | |
| Gambling, contests, loot boxes | None / No | |
| Violence (cartoon, realistic, graphic) | None | |
| Sexual content or nudity | None | |
| Profanity or crude humour | None | |
| Horror or fear themes | None | |
| Mature or suggestive themes | None | |
| Alcohol, tobacco or drug use or references | None | |
| Medical or treatment information | None | |
| Health or wellness topics | No | |

**Result: 16+.** Apple maps unrestricted web access to 16+; everything else is 4+.

**[YOU]** The only way to get a lower rating is to restrict the browser (for example to
`localhost` and an allow-list), which would break opening PR links. 16+ is normal for SSH and
browser apps and costs nothing for a developer tool, so the recommendation is to accept it.

Optional: "Made for Kids" → No. "Age rating override" → leave at the calculated rating.
