# App Store Connect — Review Information screenshots

App Store Connect asks for one "Review Information" screenshot per
auto-renewable subscription, showing where the purchase appears in the app.
The same image is fine for all four products: they are four rows on one screen.

These are **generated**, never taken by hand, and they render
`src/ios/SubscriptionScreen.ios.tsx` itself — so they cannot drift from what
actually ships. Only the store boundary is mocked
(`scripts/paywallPreview/iapMock.ts`).

## Regenerate

    npm run build:paywall
    npx http-server dist-paywall -p 8817      # or: python -m http.server 8817
    # then, per language:
    chrome --headless=new --window-size=1170,1350 --virtual-time-budget=8000 \
      --screenshot=store-assets/ios-review/paywall-ar.png \
      "http://127.0.0.1:8817/scripts/paywallPreview/index.html?lang=ar"

`?lang=ar|en` and `?theme=dark` are the knobs.

**Serve over HTTP, not `file://`.** The build is an ES module and a `file://`
origin cannot load it, so the page renders blank and the screenshot is a white
rectangle that looks like a cropping mistake rather than a failed load. The tell
is that the `ar` and `en` files come out byte-identical.

## What the reviewer must be able to see

Both are Apple requirements for an auto-renewable subscription, and both are in
the shot:

* the **auto-renew disclosure** — "يتجدد الاشتراك تلقائياً ما لم يتم إيقافه قبل
  انتهاء المدة."
* **Restore Purchases** — "استعادة المشتريات"

Prices come from RevenueCat's `priceString`, so they are the viewer's own
storefront currency; the mock pins them to the US tier the products were created
at ($1.99 / $4.99 / $7.99 / $9.99).
