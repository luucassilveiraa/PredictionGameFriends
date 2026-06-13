# World Cup Prediction Game

React/Vite version of the World Cup friends prediction game.

## What works now

- Add players
- Add/upload player photos
- Add matches manually
- Mark final scores
- Leaderboard scoring: exact score = 3 points, correct outcome = 1 point
- Upload PDF predictions through a server-side Anthropic proxy
- Import upcoming fixtures through a server-side Anthropic proxy
- Persist data in browser localStorage

## Important limitation

This version replaces Claude Artifact `window.storage` with browser `localStorage`.
That means data is stored per browser/device. It is online, but it is not yet a true shared multiplayer database.

For a real friends league where everyone sees the same players, matches, and picks, add a backend database like Supabase, Firebase, Vercel Postgres, or another API.

## Local setup

```bash
npm install
npm run dev
```

Open the local URL shown by Vite.

## Deploy to Vercel

1. Create a GitHub repo and upload this project.
2. Go to Vercel and import the repo.
3. Add environment variable:

```bash
ANTHROPIC_API_KEY=your_anthropic_api_key_here
```

4. Deploy.

The PDF reading and fixture import features require the Anthropic API key on the server. Do not put the key in frontend code.

## Build

```bash
npm run build
```
