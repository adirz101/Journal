// Packaging for GitHub Releases: macOS (Apple Silicon) DMG and ZIP, Windows
// (x64) per-user installer and portable EXE. The version comes only from
// package.json; artifact names, the app version and the release tag all derive
// from it (scripts/release-check.mjs enforces the tag).
//
// Signing is optional and never faked:
// - macOS: with CSC_LINK + CSC_KEY_PASSWORD (Developer ID Application) the app is
//   signed with the hardened runtime; with APPLE_API_KEY + APPLE_API_KEY_ID +
//   APPLE_API_ISSUER it is also notarized and stapled. Without them the app is
//   ad-hoc signed (required to run on Apple Silicon) and Gatekeeper warns.
// - Windows: with WIN_CSC_LINK (or CSC_LINK) + password the installer and app are
//   Authenticode-signed; otherwise they are unsigned and SmartScreen warns.
// CI passes the certificate as CSC_LINK; a local build names a keychain identity with CSC_NAME.
const macSigned = !!(process.env.CSC_LINK || process.env.CSC_NAME) && process.env.CSC_IDENTITY_AUTO_DISCOVERY !== 'false';
// Notarization: an App Store Connect API key (CI) or a notarytool keychain profile (local).
const notarize = macSigned && !!((process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER) || process.env.APPLE_KEYCHAIN_PROFILE);

// Stable identifier (documented in docs/RELEASING.md): never change it after a
// release, or macOS treats the app as a different program.
const APP_ID = 'io.github.adirz101.journal';

// node-pty ships sources, build intermediates and prebuilt binaries for every
// platform; only its JavaScript and the module compiled for Journal's Electron
// are needed at runtime.
const ptyCommon = ['!node_modules/node-pty/{deps,src,scripts,typings,bin}/**', '!node_modules/node-pty/binding.gyp',
  // Generated build files (Makefiles, Visual Studio and winpty projects): only build/Release ships.
  '!node_modules/node-pty/build/{deps,node_modules,node-addon-api}/**', '!node_modules/node-pty/build/*.*', '!node_modules/node-pty/build/Makefile',
  '!node_modules/node-pty/build/Release/{obj,obj.target,.deps}/**', '!node_modules/node-pty/build/Release/*.{pdb,lib,exp,iobj,ipdb,map}', '!node_modules/node-pty/node-addon-api/**', '!node_modules/node-pty/build/Release/node-addon-api/**',
  // The module is rebuilt for this Electron and architecture (npmRebuild), so the
  // multi-platform prebuilds are not shipped. Platform-level `files` lists are
  // deliberately not used: electron-builder would treat one made only of
  // exclusions as "everything" (scripts/package-audit.mjs checks the result).
  '!node_modules/node-pty/prebuilds/**',
  // Bundled ConPTY DLLs are used only with useConptyDll (off): Windows' own ConPTY is used.
  '!node_modules/node-pty/third_party/**',
  // Headers used only while compiling node-pty.
  '!node_modules/node-addon-api/**'];

module.exports = {
  appId: APP_ID,
  productName: 'Journal',
  copyright: 'Copyright 2026 Adir Zak',
  directories: { output: 'release', buildResources: 'assets/branding' },
  files: [
    'dist/**', 'src/**', 'assets/branding/journal-app-icon.png', 'package.json', 'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md',
    // The renderer ships from dist/ (no source maps); its TypeScript sources do not.
    '!src/ui/**', '!**/*.map', '!**/*.{test,spec}.{mjs,ts,js}',
    ...ptyCommon,
  ],
  asar: true,
  // Native modules and files a separate Node-mode process executes (the runtime,
  // the store worker and Claude hooks) must be real files, not app.asar entries.
  asarUnpack: ['node_modules/node-pty/**', 'src/**'],
  npmRebuild: true,
  afterPack: './scripts/after-pack.cjs',
  icon: 'assets/branding/journal-app-icon.png',
  // Where installed copies look for updates (written into the app as app-update.yml).
  // Builds never publish themselves (--publish never): the release workflow uploads
  // the update metadata (latest-mac.yml, latest.yml) with the installers.
  publish: [{ provider: 'github', owner: 'adirz101', repo: 'Journal' }],
  // One update feed for alphas and releases: latest*.yml, not alpha-*.yml.
  detectUpdateChannel: false,

  mac: {
    category: 'public.app-category.developer-tools',
    target: [{ target: 'dmg', arch: ['arm64'] }, { target: 'zip', arch: ['arm64'] }],
    // Icon Composer icon (one layer: the full-bleed artwork, no glass effects). actool
    // (Xcode 26 or later) compiles it to Assets.car for macOS 26+, which shapes it
    // itself, and to a rounded Icon.icns for earlier macOS. The rounded original
    // PNG would sit on a grey platter on macOS 26+.
    icon: 'assets/branding/Journal.icon',
    artifactName: '${productName}-${version}-${arch}.${ext}',
    // Ad-hoc ("-") when no Developer ID is configured: Apple Silicon refuses
    // to run unsigned code, and a quarantined app with a broken signature is
    // reported as "damaged". Ad-hoc is not a trusted signature; Gatekeeper still warns.
    identity: macSigned ? undefined : '-',
    hardenedRuntime: macSigned,
    gatekeeperAssess: false,
    entitlements: 'assets/entitlements.mac.plist',
    entitlementsInherit: 'assets/entitlements.mac.plist',
    notarize,
  },
  dmg: {
    artifactName: '${productName}-${version}-${arch}.${ext}',
    // Journal.app and an Applications link: drag to install.
    contents: [{ x: 160, y: 200, type: 'file' }, { x: 440, y: 200, type: 'link', path: '/Applications' }],
    window: { width: 600, height: 400 },
    writeUpdateInfo: false,
  },

  win: {
    target: [{ target: 'nsis', arch: ['x64'] }, { target: 'portable', arch: ['x64'] }],
    // Signs only when a certificate is configured (WIN_CSC_LINK or CSC_LINK).
    signAndEditExecutable: true,
    verifyUpdateCodeSignature: false,
    legalTrademarks: 'Journal',
  },
  nsis: {
    artifactName: '${productName}-Setup-${version}-${arch}.${ext}',
    // One-click, per user (%LOCALAPPDATA%\Programs\journal-desktop): no
    // administrator rights and no "all users / only me" choice to get wrong.
    oneClick: true,
    perMachine: false,
    createStartMenuShortcut: true,
    createDesktopShortcut: false,
    shortcutName: 'Journal',
    // Journal's data (%APPDATA%\journal-desktop) is kept on uninstall.
    deleteAppDataOnUninstall: false,
    differentialPackage: false,
  },
  portable: {
    artifactName: '${productName}-Portable-${version}-${arch}.${ext}',
  },
};
