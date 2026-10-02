# Daniel Analytics

Hosted usage collection sends fixed event names, coarse device class and static route templates to the first-party portfolio collector. Both pseudonymous identifiers live only for the current tab session; they do not identify accounts or connect different products. No form, document, student, health, ride, chat, order, research, camera or voice content is sent. No event properties or raw URLs are accepted by this SDK.

Collection honors Do Not Track, Global Privacy Control and the visible Turn off control. Local/offline origins are disabled. Owner-scoped preview deployments are labeled preview and excluded from production reports. Analytics transport failures do not change product results.

Source: Analytics/shared/browser.js and browser.d.ts. Keep those copies together when updating. The event allowlist is in the adjacent index module. Reported completion means the instrumented workflow returned its result; it does not establish outcome quality, a verified human, statistical significance or revenue.

The Render MCP server has a separate `omschatgptapp-mcp` profile, measured per tool request. Eight existing inquiry/cancellation handlers record requested/completed/failed events with fresh IDs per invocation. Initialization, widget reads, debugging and reset tools are excluded. Successful completion includes a confirmation prompt and does not imply an order cancellation. No MCP arguments, output content, account IDs, order IDs or transport IDs enter the recorder.

Server collection honors DNT, GPC and `X-Daniel-Analytics-Disabled: true` request headers, and the operator can set `DANIEL_ANALYTICS_DISABLED=true`. Render PR previews and local runs are disabled. Delivery runs in the background and cannot change the existing tool result or block it on analytics. The widget does not make a new analytics connection or change its CSP. Actual Render deployment must be verified independently from the Vercel frontend.

This is an existing React widget and MCP server; the split structure and current compatibility metadata stay intact. Official references: [MCP server contracts](https://developers.openai.com/apps-sdk/build/mcp-server), [ChatGPT UI](https://developers.openai.com/apps-sdk/build/chatgpt-ui), [tool design](https://developers.openai.com/apps-sdk/plan/tools), [Apps reference](https://developers.openai.com/apps-sdk/reference), [Render environment flags](https://render.com/docs/environment-variables).
