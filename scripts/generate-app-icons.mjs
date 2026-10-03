// Regenerate every launcher icon, notification icon, splash image and web icon
// from one logo master.
//
// Why this exists instead of `npx capacitor-assets generate`:
//
//  1. assets/Normallogo.png is not a transparent logo. It is an opaque square
//     with the mark rendered on a flat WHITE ground. capacitor-assets takes that
//     at face value and hands it to the adaptive icon's foreground layer, so the
//     white ground rides along and shows up as a box behind the mark on the
//     launcher and on the Android 12+ splash. Stripping the ground is step one
//     here, and no amount of layer/inset tweaking substitutes for it.
//  2. That tool also insets the adaptive icon's BACKGROUND layer by 16.7%, so
//     the plate never reaches the edge of the 108dp canvas. Launchers that
//     force a shape then wrap the icon in a plate of their own to compensate.
//  3. It writes the adaptive layers at LEGACY densities -- 192px at xxxhdpi,
//     where the adaptive canvas is 108dp and xxxhdpi is 4x, so the correct size
//     is 432px. The system upscales 2.25x and the mark comes out soft.
//
// Everything is derived from the mark's own bounding box after the ground comes
// off, so the result does not depend on how much padding the source carries.
// Re-run after replacing the master:
//
//     npm run icons
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { compose, extractMark, markAt, silhouette, trimToMark, write } from './lib/iconAssets.mjs';

/** The single source of truth. The white ground and any padding come off automatically. */
const LOGO = 'assets/Normallogo.png';

/**
 * The same artwork pre-keyed onto transparency, used ONLY for the notification
 * silhouette. Its background removal also punched out the book's inner outline
 * strokes; that is wrong for a coloured icon (the plate would show through) but
 * exactly right for a stencil, where those holes are the only thing keeping the
 * book legible at 24dp. See silhouette() in lib/iconAssets.mjs.
 */
const LOGO_ALPHA = 'assets/TransparentBGlogo.png';

/**
 * Plate colour behind the mark, everywhere.
 *
 * White, because the mark is a LIGHT BLUE render and anything blue behind it
 * has no contrast. It also matches @color/ic_launcher_background,
 * @color/splashBackground and capacitor.config.ts's SplashScreen background,
 * all of which were already white -- the previous blue-gradient plate here
 * agreed with none of them, and since the old foreground was a white glyph the
 * adaptive icon rendered white-on-white and was invisible on Android 8+.
 *
 * White also matches extractMark's edge behaviour: the mark keeps a faint pale
 * fringe where it was anti-aliased against the ground, which composites back to
 * exactly the original artwork on white and would read as a halo on anything
 * darker.
 */
const BG = '#FFFFFF';

/** Notification tint. Android colours the stencil itself; this is the accent it uses. */
const NOTIFICATION_ACCENT = '#3E86B5';

const RES = 'android/app/src/main/res';

// Adaptive icons are drawn on a 108dp canvas of which only the middle 72dp
// (66.7%) survives the launcher's mask, and only a 66dp circle survives EVERY
// mask shape. If the mark has content in the corners of its bounding box, the
// box DIAGONAL -- not its width -- is what has to fit that circle: at 0.46 a
// square-ish mark's corners land at a diameter of ~0.61, inside the 0.667
// circle with room to spare, and the mark still reads at ~69% of the visible
// area. The current mark's aspect is 1.05, so it counts as square-ish.
const ADAPTIVE_LOGO = 0.46;
/** Legacy pre-API-26 icons are unmasked, so the mark can be larger. */
const LEGACY_LOGO = 0.62;
/** Fraction of the SHORT screen edge the splash mark occupies. */
const SPLASH_LOGO = 0.3;
/** Web PWA icons: "any" is drawn full-bleed, "maskable" gets an 80% safe zone. */
const WEB_LOGO = 0.72;
const WEB_MASKABLE_LOGO = 0.55;
/** Notification stencils get a little breathing room inside their 24dp frame. */
const NOTIFICATION_LOGO = 0.9;

/** Adaptive layers: 108dp at each density bucket. */
const ADAPTIVE_DENSITIES = {
  ldpi: 81,
  mdpi: 108,
  hdpi: 162,
  xhdpi: 216,
  xxhdpi: 324,
  xxxhdpi: 432,
};

/** Legacy launcher icons: 48dp at each density bucket. */
const LEGACY_DENSITIES = {
  ldpi: 36,
  mdpi: 48,
  hdpi: 72,
  xhdpi: 96,
  xxhdpi: 144,
  xxxhdpi: 192,
};

/** Notification icons: 24dp at each density bucket. */
const NOTIFICATION_DENSITIES = {
  ldpi: 18,
  mdpi: 24,
  hdpi: 36,
  xhdpi: 48,
  xxhdpi: 72,
  xxxhdpi: 96,
};

function log(file, note) {
  console.log(`  ${file}${note ? `  ${note}` : ''}`);
}

async function main() {
  for (const f of [LOGO, LOGO_ALPHA]) {
    if (!fs.existsSync(f)) {
      console.error(`generate-app-icons: ${f} not found`);
      process.exit(1);
    }
  }

  // One mark for everything coloured. The old master was a white glyph painted
  // on a blue card, which needed a second keying pass to separate the two; this
  // one is the mark itself on a plain ground, so lifting the ground is the whole
  // job and the foreground and splash artwork are the same buffer.
  const mark = await extractMark(LOGO);
  const stencil = await silhouette(await trimToMark(LOGO_ALPHA));
  const pct = ((mark.width / mark.canvas) * 100).toFixed(1);
  console.log(
    `Master  ${LOGO} (${mark.canvas}px)\n` +
      `Mark    ${mark.width}x${mark.height} at (${mark.box.left},${mark.box.top}) -- ${pct}% of the master, ground removed\n` +
      `Stencil ${stencil.width}x${stencil.height} from ${LOGO_ALPHA}\n` +
      `Plate   ${BG}\n`,
  );

  // Keep the stripped mark on disk: it is what every other asset is built from,
  // and having it inspectable is the difference between trusting this script
  // and re-deriving the ground-removal problem from scratch next time.
  write('assets/logo-mark.png', mark.buf);
  log('assets/logo-mark.png', `${mark.width}x${mark.height} transparent`);

  console.log('\nassets/ masters');
  write('assets/icon.png', await compose(mark, 1024, 1024, Math.round(1024 * LEGACY_LOGO), BG));
  log('icon.png', '1024x1024 plate + mark');
  for (const f of ['assets/splash.png', 'assets/splash-dark.png']) {
    write(f, await compose(mark, 2732, 2732, Math.round(2732 * SPLASH_LOGO), BG));
    log(path.basename(f), '2732x2732');
  }

  console.log('\nAndroid adaptive icon (108dp canvas)');
  for (const [density, size] of Object.entries(ADAPTIVE_DENSITIES)) {
    // Foreground only. The <background> in mipmap-anydpi-v26/ic_launcher.xml is
    // bound to @color/ic_launcher_background, so a per-density background PNG
    // here would never be read -- six of them used to be written and were dead
    // weight in every APK.
    write(
      `${RES}/mipmap-${density}/ic_launcher_foreground.png`,
      await compose(mark, size, size, Math.round(size * ADAPTIVE_LOGO), null),
    );
    log(`mipmap-${density}/ic_launcher_foreground.png`, `${size}px`);
  }

  console.log('\nAndroid legacy icon (48dp canvas)');
  for (const [density, size] of Object.entries(LEGACY_DENSITIES)) {
    const dir = `${RES}/mipmap-${density}`;
    const m = Math.round(size * LEGACY_LOGO);
    write(`${dir}/ic_launcher.png`, await compose(mark, size, size, m, BG, size * 0.2));
    write(`${dir}/ic_launcher_round.png`, await compose(mark, size, size, m, BG, size / 2));
    log(`mipmap-${density}/ic_launcher{,_round}.png`, `${size}px`);
  }

  // Android tints these itself and throws the colour away, so they are white on
  // transparency. Without them FCM falls back to @mipmap/ic_launcher, which the
  // system flattens into a featureless white blob on API 21+.
  console.log('\nAndroid notification icon (24dp canvas)');
  for (const [density, size] of Object.entries(NOTIFICATION_DENSITIES)) {
    write(
      `${RES}/drawable-${density}/ic_notification.png`,
      await compose(stencil, size, size, Math.round(size * NOTIFICATION_LOGO), null),
    );
    log(`drawable-${density}/ic_notification.png`, `${size}px  tinted ${NOTIFICATION_ACCENT}`);
  }

  // Every density/orientation/night variant that already exists keeps its exact
  // dimensions. Night gets the same white plate as day: the chosen plate is
  // white in both modes, and values-night/colors.xml pins splashBackground to
  // match, so a dark splash behind a white icon box cannot happen.
  console.log('\nSplash screens');
  const splashDirs = fs
    .readdirSync(RES)
    .filter((d) => d.startsWith('drawable') && fs.existsSync(`${RES}/${d}/splash.png`));
  for (const d of splashDirs) {
    const file = `${RES}/${d}/splash.png`;
    const { width, height } = await sharp(file).metadata();
    write(
      file,
      await compose(mark, width, height, Math.round(Math.min(width, height) * SPLASH_LOGO), BG),
    );
  }
  log(`${splashDirs.length} splash.png variants`, 'regenerated at their existing sizes');

  console.log('\nWeb icons');
  for (const size of [192, 512]) {
    write(
      `public/icons/icon-${size}.png`,
      await compose(mark, size, size, Math.round(size * WEB_LOGO), BG),
    );
    write(
      `public/icons/icon-maskable-${size}.png`,
      await compose(mark, size, size, Math.round(size * WEB_MASKABLE_LOGO), BG),
    );
    log(`icon-${size}.png, icon-maskable-${size}.png`);
  }

  // The web-push badge is the status-bar glyph Chrome shows on Android. Like the
  // native notification icon it is masked down to its alpha, so it reuses the
  // same stencil rather than the coloured mark.
  write('public/icons/badge-72.png', await compose(stencil, 72, 72, Math.round(72 * NOTIFICATION_LOGO), null));
  log('badge-72.png', '72x72 monochrome, for the web-push badge');

  // The mark on TRANSPARENCY, for in-app chrome. The installable icons above all
  // carry the white plate, which is right on a launcher and wrong inside the
  // app: Navbar and LoginScreen sit the logo in a tinted (bg-sky-50 / bg-sky-100)
  // rounded container, where a plated PNG reads as a white box punched into it.
  write('public/icons/logo-mark.png', await compose(mark, 256, 256, 256, null));
  log('logo-mark.png', '256x256 transparent, for in-app UI');

  // iOS app icon. Xcode 14+ uses a single 1024×1024 universal icon, referenced
  // in Contents.json as AppIcon-512@2x.png (the name is Capacitor's convention;
  // the file is 1024px, i.e. @2x of the 512pt slot). Until this line existed
  // the placeholder Capacitor "X" was what shipped.
  console.log('\niOS app icon');
  write(
    'ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png',
    await compose(mark, 1024, 1024, Math.round(1024 * LEGACY_LOGO), BG),
  );
  log('AppIcon-512@2x.png', '1024x1024 for iOS (single universal icon)');

  // Deliberately NO icon.svg / icon-maskable.svg.
  //
  // They used to be written here as an SVG wrapper around the mark base64-encoded
  // into an <image> href, on the reasoning that the service worker precached them
  // and dropping them would need an sw version bump. That is not true of a
  // `generateSW` setup: the precache list is a build-time glob over dist, so a
  // file that stops being emitted simply stops being listed.
  //
  // Nothing else ever read them -- the web manifest references only PNGs. With
  // this mark, which is a photographic 3D render rather than the flat glyph they
  // were designed around, each came to 222 KB, so the pair was adding ~440 KB to
  // every user's offline cache to serve no consumer at all.

  console.log('\nDone.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
