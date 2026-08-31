# Brand assets

`logo.svg` is the source. The glyph is Material Design Icons "archive"
(Apache-2.0) in white with a black keyline, on the same `#D97757` plate the
other Claude Code plugins in this account use.

`logo.png` (512px) is for the repository and marketplace listings.
`logo-120.png` is sized for the Google OAuth consent screen.

Regenerate the PNGs from the SVG geometry with `scripts/logo.py`.

**Do not upload a logo to an External OAuth app that is published to
production.** Google requires brand verification once a logo is set, unless the
app is Internal or still in Testing. The consent screen for the shipped Internal
client can carry it; the personal External client must not.
