# Daniel Analytics

Hosted usage collection sends fixed event names, coarse device class and static route templates to the first-party portfolio collector. Both pseudonymous identifiers live only for the current tab session; they do not identify accounts or connect different products. No form, document, student, health, ride, chat, order, research, camera or voice content is sent. No event properties or raw URLs are accepted by this SDK.

Collection honors Do Not Track, Global Privacy Control and the visible Turn off control. Local/offline origins are disabled. Owner-scoped preview deployments are labeled preview and excluded from production reports. Analytics transport failures do not change product results.

Source: Analytics/shared/browser.js and browser.d.ts. Keep those copies together when updating. The event allowlist is in the adjacent index module. Reported completion means the instrumented workflow returned its result; it does not establish outcome quality, a verified human, statistical significance or revenue.
