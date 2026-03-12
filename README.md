# Hoster

A lightweight, self-hosted web hosting platform that runs on a Raspberry Pi (or any Linux device) and serves sites to the public via [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) — no open ports, no dynamic DNS, free SSL.

Upload a ZIP file through the web admin panel and your site is live at `https://yourdomain.com/your-site/` within seconds.

## Features

- **Zero-config HTTPS** — Cloudflare handles SSL termination automatically
- **Web admin panel** — deploy, update, and manage sites from anywhere
- **Version management** — each upload creates a new version; roll back instantly
- **SPA support** — auto-detects Angular, React, and Vue builds; rewrites `<base href>` for subpath hosting
- **Analytics dashboard** — request logs, visitor stats, countries, top pages, status codes
- **Secure auth** — Argon2id password hashing, session tokens, rate-limited login
- **Light/Dark/Auto themes** — admin panel respects system preference
- **Single binary** — compiles to a standalone executable with no runtime dependencies
- **Tiny footprint** — runs comfortably on a Raspberry Pi with minimal resources

## How It Works

```
User → Cloudflare (HTTPS) → Tunnel → Your Pi (HTTP :3500) → Static Files
```

Sites are served at `yourdomain.com/<slug>/` where each slug maps to an uploaded site. The admin panel lives at `yourdomain.com/_admin`.

## Prerequisites

- A Linux device (Raspberry Pi, VPS, old laptop, etc.)
- [Bun](https://bun.sh) installed on your **build machine** (Mac/Linux) — not needed on the Pi
- A domain name with DNS managed by Cloudflare (free tier works)
- `cloudflared` installed on your Pi

## Setup Guide

### 1. Set Up Cloudflare Tunnel

Install `cloudflared` on your Pi:

```bash
# For Raspberry Pi (ARM64)
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64 -o cloudflared
sudo mv cloudflared /usr/local/bin/
sudo chmod +x /usr/local/bin/cloudflared

# Authenticate with Cloudflare
cloudflared tunnel login
```

Create a tunnel:

```bash
cloudflared tunnel create hoster
```

This outputs a tunnel ID (UUID) and creates a credentials file at `~/.cloudflared/<TUNNEL_ID>.json`.

### 2. Configure DNS

Route your domain to the tunnel:

```bash
cloudflared tunnel route dns hoster yourdomain.com
```

This creates a CNAME record in Cloudflare DNS pointing your domain to the tunnel.

### 3. Configure the Tunnel

Create the config file at `~/.cloudflared/config.yml`:

```yaml
tunnel: hoster
credentials-file: /home/youruser/.cloudflared/<TUNNEL_ID>.json

ingress:
  - hostname: yourdomain.com
    service: http://localhost:3500
  - service: http_status:404
```

> **Tip:** You can add multiple services on the same device. Just add more ingress rules with different hostnames or subdomains, each pointing to a different local port.

### 4. Install Tunnel as a Service

```bash
sudo cloudflared service install
sudo systemctl enable cloudflared
sudo systemctl start cloudflared
```

> **Important:** When installed as a service, cloudflared reads config from `/etc/cloudflared/config.yml`, not `~/.cloudflared/config.yml`. Make sure your config is in the right place, or copy it:
> ```bash
> sudo cp ~/.cloudflared/config.yml /etc/cloudflared/
> sudo cp ~/.cloudflared/<TUNNEL_ID>.json /etc/cloudflared/
> ```

### 5. Build Hoster

On your build machine (Mac or Linux with Bun installed):

```bash
git clone https://github.com/davidgeller/hoster.git
cd hoster
bash build-pi.sh
```

This compiles a standalone ARM64 binary and packages it into a self-extracting installer (`hoster-pi.sh`).

### 6. Deploy to Your Pi

```bash
scp hoster-pi.sh youruser@yourpi:~/
ssh youruser@yourpi 'bash ~/hoster-pi.sh'
```

### 7. Start Hoster

```bash
# Install as a systemd service
sudo cp ~/hoster/hoster.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hoster

# Check it's running
sudo journalctl -u hoster -f
```

### 8. Set Your Admin Password

Open `https://yourdomain.com/_admin` in your browser. On first visit, you'll be prompted to create an admin password (minimum 8 characters).

## Deploying Sites

1. Go to `https://yourdomain.com/_admin`
2. Click **Deploy Site**
3. Enter a slug (e.g., `my-app`) — this becomes the URL path
4. Upload a ZIP file containing your site files
5. Your site is live at `https://yourdomain.com/my-app/`

### Updating a Site

Click **Update** on a site card, upload a new ZIP. This creates a new version while keeping previous versions available for rollback.

### SPA (Single Page App) Support

Hoster automatically detects Angular, React, and Vue builds:

- **Root directory detection** — if your ZIP contains a `browser/`, `dist/`, `build/`, or similar subdirectory with `index.html`, Hoster serves from there
- **Base href rewriting** — `<base href="/">` is automatically rewritten to `<base href="/your-slug/">` so asset paths work correctly under a subpath
- **SPA routing** — enable SPA mode in site Settings to serve `index.html` for all unmatched routes (required for client-side routing)

You can adjust these settings per site via the **Settings** button on each site card.

## Upgrading Hoster

On your build machine:

```bash
cd hoster
git pull
bash build-pi.sh
scp hoster-pi.sh youruser@yourpi:~/
ssh youruser@yourpi 'bash ~/hoster-pi.sh && sudo systemctl restart hoster'
```

Your data (admin password, sites, analytics) is preserved across upgrades.

## Verifying Your Setup

```bash
# Check tunnel is connected
sudo systemctl status cloudflared

# Check hoster is running
curl -s http://localhost:3500/_admin/api/version

# Check from the internet
curl -s https://yourdomain.com/_admin/api/version
```

## Project Structure

```
hoster/
├── admin/              # Admin panel (HTML/CSS/JS)
│   ├── index.html
│   ├── style.css
│   └── app.js
├── src/                # Server source (TypeScript)
│   ├── index.ts        # Entry point
│   ├── server.ts       # HTTP server & routing
│   ├── auth.ts         # Authentication & sessions
│   ├── admin-api.ts    # Admin REST API
│   ├── analytics.ts    # Request logging & dashboard queries
│   ├── sites.ts        # Site management & versioning
│   ├── db.ts           # SQLite database setup
│   └── setup.ts        # CLI password setup
├── deploy/
│   └── install.sh      # Pi installer template
├── build-pi.sh         # Build script
├── package.json
└── .gitignore
```

Runtime directories (created on the Pi, not in git):

```
~/hoster/
├── data/               # SQLite database
│   └── hoster.db
├── sites/              # Deployed sites
│   └── <slug>/
│       ├── <version>/  # Timestamped version directories
│       └── _current    # Symlink to active version
├── admin/              # Admin panel assets
└── hoster              # Compiled binary
```

## Security

- Admin password is hashed with **Argon2id** (memory-hard, GPU-resistant)
- Sessions use 256-bit random tokens with configurable expiration (default 72h)
- Login is **rate-limited** (5 attempts per 15 minutes per IP)
- Session cookies are `HttpOnly`, `Secure`, `SameSite=Strict`
- Path traversal protection on all file serving
- No ports exposed — all traffic goes through Cloudflare's encrypted tunnel
- Cloudflare provides DDoS protection, WAF, and bot management at the edge

## Analytics

Hoster captures request metadata for every visitor:

- IP address, country, city (via Cloudflare headers)
- User agent, referrer, accept-language
- Request path, method, status code, response time
- All data stored locally in SQLite — nothing sent to third parties

The admin dashboard shows traffic over time, top sites, top paths, countries, status codes, and recent request logs.

## Multiple Services on One Device

Cloudflare Tunnel supports multiple ingress rules, so you can run several services on one Pi. Example config:

```yaml
tunnel: my-tunnel
credentials-file: /etc/cloudflared/<TUNNEL_ID>.json

ingress:
  - hostname: api.yourdomain.com
    service: http://localhost:3000
  - hostname: yourdomain.com
    service: http://localhost:3500
  - service: http_status:404
```

## License

MIT
