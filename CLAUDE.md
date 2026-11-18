# Working on this repository

## Major changes update qstored.org

Any major change here (a feature added, changed or removed, a new plan limit or badge, a redesigned screen) also
updates Pinewood Control's page on qstored.org, in the same piece of work:

1. Update its features on qstored.org's product page (/pinewood-control): in no5tyle/qstored, change `scripts/product-pages.py` (each feature's heading, plan badges with any limit, and a few words) and run `python3 scripts/product-pages.py`.
2. If a screen it shows has changed, retake the pictures: `node scripts/product-shots.cjs ../qstored/shots/pinewood-control` from this repository (see the script's first lines for what must be running), then `python3 scripts/product-images.py` in no5tyle/qstored.
3. Demo data in screenshots uses short, clean names and emails (Akela, `akela@example.com`): never real people, and never long generated addresses.

See no5tyle/qstored's README, "Keeping the product pages up to date".
