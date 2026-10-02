import { createAnalytics } from "./browser.js";
export const analytics = createAnalytics({
  "app": "omschatgptapp",
  "origins": [
    "https://omschatgptapp.vercel.app",
    "https://omschatgptapp-danash1611-3756s-projects.vercel.app",
    "https://omschatgptapp-git-main-danash1611-3756s-projects.vercel.app"
  ],
  "previewPrefix": "omschatgptapp",
  "pages": [
    "/",
    "/other"
  ],
  "events": [
    "assistant_requested",
    "assistant_responded",
    "assistant_failed"
  ]
});
