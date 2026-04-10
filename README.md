# Beauty Pageant App

Small full-stack pageant scoring app built with Express, LowDB, Socket.IO, and vanilla HTML/CSS/JS.

## What It Does

- Admin dashboard for managing contestants, judges, and scoring categories
- Judge login and score submission
- Real-time leaderboard updates
- Local JSON storage in `db.json`
- Optional contestant photo uploads stored in `uploads/`

## Stack

- Node.js
- Express
- LowDB
- Socket.IO
- Bootstrap 5
- Vanilla JavaScript

## Run It

1. Install dependencies:

```bash
npm install
```

2. Start the server:

```bash
npm start
```

3. Open the app:

- Judge portal: `http://localhost:3000/`
- Admin dashboard: `http://localhost:3000/admin.html`

## Default Admin Login

- Username: `admin`
- Password: `password`

Change it after first login from the admin dashboard.

## Data Files

- `db.json`: app data
- `uploads/`: contestant images
- `public/`: frontend files
- `server.js`: backend and realtime logic

## Notes

- Judge and admin sessions are stored with `express-session`.
- Category weights are validated so the total cannot exceed `100%`.
- Uploaded files are limited to image types and `5 MB`.
