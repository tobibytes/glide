# glide.madebytobi.com

The product page for Glide: one static `index.html` plus images, no build step. It's deployed on Vercel as the `glide` project (`cd site && vercel deploy --prod`).

The screenshots in `img/` are the native app's launcher, rendered offscreen by the headless test server's `snapshot` command. The download buttons link to the newest `.dmg` through the GitHub releases API, so new releases need no site change.
