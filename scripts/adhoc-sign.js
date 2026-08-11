const { execFileSync } = require('node:child_process')
const path = require('node:path')

/*
 * Ad-hoc sign the packaged app.
 *
 * electron-builder's `identity: null` does not mean "unsigned" — it means
 * "skip signing", which leaves the bundle carrying the Electron binary's own
 * linker-signed signature. That signature seals no resources and does not
 * describe the bundle we just built, so codesign reports it as broken:
 *
 *   code has no resources but signature indicates they must be present
 *
 * Gatekeeper treats a broken signature far more harshly than a missing one. A
 * quarantined app with one is refused outright as "damaged and can't be
 * opened" — a dead end with no override in the UI. Ad-hoc signing does not
 * make the app trusted (there is still no Developer ID), but it makes the
 * signature honest, so a new machine gets the ordinary "unidentified
 * developer" dialog and its Open Anyway path instead.
 *
 * Runs from afterPack rather than afterSign: with signing skipped, afterSign
 * never fires.
 */
exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return

  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)

  /*
   * Nested code has to be signed innermost-first, or sealing the outer bundle
   * captures hashes that the later inner signatures invalidate. --deep does
   * that walk for us; it is discouraged for Developer ID signing, where each
   * component needs its own entitlements, but for ad-hoc there are none.
   */
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' })

  // Fail the build rather than ship another bundle that only looks signed.
  execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], {
    stdio: 'inherit'
  })
  console.log(`  • ad-hoc signed  ${path.basename(app)}`)
}
