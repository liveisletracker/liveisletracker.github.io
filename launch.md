# Live Isle Tracker — Launch Checklist

## 1. Create Fly.io Account
**Status:** [ ] Not Started

- Go to https://fly.io and sign up (free tier)
- No credit card required for free tier

---

## 2. Install Fly CLI
**Status:** [ ] Not Started

Open PowerShell and run:
```
powershell -Command "iwr https://fly.io/install.ps1 -useb | iex"
```
Then close and reopen your terminal so `fly` is on PATH.

---

## 3. Log In to Fly
**Status:** [ ] Not Started

```
fly auth login
```
This opens your browser to authenticate.

---

## 4. Deploy WebSocket Server to Fly.io
**Status:** [ ] Not Started

```
cd D:\projects\isle-tracker\server
fly launch --no-deploy
```
- When prompted: accept the app name `live-isle-tracker` (or pick another)
- Region: pick the closest to you (e.g., `iad` for US East)
- No database needed

Then deploy:
```
fly deploy
```
Wait for it to finish. Note your app URL: `https://live-isle-tracker.fly.dev`

---

## 5. Update WS_URL to Production
**Status:** [ ] Not Started

In `app.js` line 9, change:
```js
const WS_URL = 'ws://localhost:3000';
```
to:
```js
const WS_URL = 'wss://live-isle-tracker.fly.dev';
```
(Replace `live-isle-tracker` with your actual Fly app name if different)

---

## 6. Create GitHub Repository
**Status:** [ ] Not Started

- Go to https://github.com/new
- Name: `live-isle-tracker`
- Public repo
- Don't initialize with README

---

## 7. Push Code to GitHub
**Status:** [ ] Not Started

```
cd D:\projects\isle-tracker
git init
git add index.html app.js ocr.js map-light.png water.png mudOverlay.png structures.png migration.png sanctuaries.png launch.md
git add server/
git commit -m "Initial release — Live Isle Tracker"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/live-isle-tracker.git
git push -u origin main
```

---

## 8. Enable GitHub Pages
**Status:** [ ] Not Started

- Go to your repo on GitHub
- **Settings** → **Pages**
- Source: **Deploy from a branch**
- Branch: **main** / folder: **/ (root)**
- Click **Save**
- Wait 1-2 minutes, then your site is live at:
  `https://YOUR_USERNAME.github.io/live-isle-tracker/`

---

## 9. Test End-to-End
**Status:** [ ] Not Started

1. Open `https://YOUR_USERNAME.github.io/live-isle-tracker/` in Chrome
2. Create a room, note the code
3. Open a second browser/device, join with the code
4. Both: Share Screen → select region → press Tab in-game
5. Verify both dots appear on the map
6. Test waypoint (right-click on map)
7. Test overlay toggles (Migration, Sanctuaries, Salt)

---

## 10. Share with Friends
**Status:** [ ] Not Started

Send them the GitHub Pages URL. They just:
1. Open the link in Chrome/Edge
2. Enter name, join your room code
3. Share screen, select region, press Tab

No installs needed.
