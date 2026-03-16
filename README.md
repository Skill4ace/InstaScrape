# InstaScrape Follower Diff

Chrome extension MVP for comparing the active Instagram profile's `followers` and `following` lists and surfacing who is not following back.

## Load it

1. Open `chrome://extensions`.
2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select this folder: `/Users/skill4ace/InstaScrape`.

## Use it

1. Log in to Instagram in Chrome.
2. Open a profile root page such as `https://www.instagram.com/rehan_nagabandi/`.
3. Click the extension icon to open the side panel.
4. Click `Analyze Current Profile`.
5. Keep the Instagram tab active while the scraper scrolls the `Followers` and `Following` dialogs.

## Notes

- The scraper reads usernames from the Instagram page DOM in your active browser session.
- Progress and the latest results are stored in `chrome.storage.local`.
- If Instagram changes the dialog markup or interrupts the session, clear the state and retry from the profile root page.
