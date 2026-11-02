# White Elephant Tracker

A small web app for running a White Elephant gift exchange.

- **Gift Master** mode: create a game, manage players and turn order, and record every open, steal and swap. Includes undo.
- **Player** mode: enter the game code and your name, then watch the board live: whose turn it is, who holds what, and how many steals each gift has left.

No login and no database. A tiny Node server (`server.js`) serves the page and pushes live updates over WebSockets. Games are kept in server memory. The gift master's browser keeps a backup in localStorage.

## Rules the app enforces

- **Round 1:** players go in turn order. The active player opens a wrapped gift or steals an opened one.
  - If someone steals your gift, you go next. You can't steal that same gift straight back.
  - Once someone opens a gift, the turn passes to the next player in order.
- **Rounds 2 and up** (3 rounds by default): each player may swap their gift for any unlocked gift, keep it ("happy"), or pass.
  - A happy player is skipped in later rounds.
  - If a happy player's gift is swapped away, they become unhappy again.
- **Each gift locks after 3 steals** (configurable). Swaps count as a steal on the gift taken.
- **The game ends** when any of these happens:
  - all rounds are played;
  - everyone is happy;
  - every gift is locked;
  - the master ends it.

## Run locally

```bash
npm install
npm start
```

Open http://localhost:3000. Use `PORT=xxxx npm start` to change the port.

## Deploy on Render (free)

1. Push this folder to a GitHub repo.
2. In Render, choose **New > Web Service** and pick the repo. Use these settings:
   - Runtime: **Node**
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Instance type: **Free**
   - Health check path (optional): `/healthz`
3. Share the `https://<your-app>.onrender.com` URL.

### Free-tier notes
- The service sleeps after 15 minutes with no traffic. The first visit after that takes about 30–60 s to wake it. Open the site a minute before the game starts.
- An open game keeps it awake: connected phones get a ping every 30 s.
- A restart or redeploy wipes server memory. When the gift master's device reconnects, it sends its backup and the game comes back. Players reconnect on their own. Undo history before the restart is lost.
- Games idle for 24 hours are removed.

## Playing

1. The master opens the site and picks **I'm the Gift Master > New game**, then sets a PIN.
2. Share the 4-letter code or the **player link**. Players open it, type their name, and appear in the lobby.
3. The master can shuffle or reorder the turn order, add players who have no phone, and change settings. Then press **Start**.
4. On each turn the master either:
   - types what was opened, or
   - taps **Steal**/**Swap** on a gift.

   Mistakes can be fixed with **Undo**.
5. A player who loses their session can rejoin by typing the same name.

The server checks the master PIN on every master action, and the PIN is never sent to players. Players can only join and watch. There are no accounts, so don't store anything sensitive.
