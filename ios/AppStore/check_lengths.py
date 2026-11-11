"""Check the App Store fields in listing.md against Apple's limits.

Run from anywhere: python3 ios/AppStore/check_lengths.py
Each field is the first ``` block after its heading.
"""
import pathlib, re, sys

LIMITS = {
    "Name": 30,
    "Subtitle": 30,
    "Promotional text": 170,
    "Description": 4000,
    "Keywords": 100,
}

text = (pathlib.Path(__file__).parent / "listing.md").read_text()
ok = True
for field, limit in LIMITS.items():
    m = re.search(r"^### " + re.escape(field) + r".*?\n```\n(.*?)\n```", text, re.S | re.M)
    if not m:
        print(f"{field}: not found"); ok = False; continue
    value = m.group(1)
    n = len(value.encode()) if field == "Keywords" else len(value)
    flag = "ok" if n <= limit else "TOO LONG"
    ok &= n <= limit
    print(f"{field:17} {n:5} / {limit}  {flag}")
sys.exit(0 if ok else 1)
