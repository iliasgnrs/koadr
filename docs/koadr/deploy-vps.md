# Deploying Koadr to the VPS

The VPS (`app.koadr.dev`, `91.98.89.225`) is the only deployment target. Images are built
locally and shipped; nothing is built on the host (no Node toolchain there, and it
competes with the WordPress stack for RAM).

`ssh adapedu-vps` → `root@91.98.89.225`. The stack lives at `/opt/koadr`.

**Currently running:** `koadr-web:orangetheme`. The previous release is
`koadr-web:authparticles`, so a rollback needs no re-upload.

## 1. Build

```bash
docker build --platform linux/amd64 --target koadr-production -t koadr-web:<tag> .
```

`--target koadr-production` is **required**. Without it Docker builds the last stage in
the Dockerfile (`development`), which starts `react-router dev` and crashes on
`Option '--host <value>' argument missing`.

Tag by purpose — `chatfixes`, `agentfix4`, `slice4c` — not `latest`. The pinned tag in
`/opt/koadr/docker-compose.yml` is what the host runs, and a distinct tag per release is
what makes rollback a one-line edit.

## 2. Smoke-test locally

```bash
docker run -d --name koadr-smoke -p 3987:3000 koadr-web:<tag>
curl -s -o /dev/null -w "%{http_code} %{size_download}\n" http://127.0.0.1:3987/login
docker logs koadr-smoke 2>&1 | tail -20
docker rm -f koadr-smoke
```

Expect `/login` → 200 with a non-trivial body and `/` → 302 to `/login`. `SUPABASE_URL
and SUPABASE_ANON_KEY must be set on the server` in the logs is expected here: the smoke
container has no `.env`.

## 3. Ship the image

```bash
docker save koadr-web:<tag> | gzip -1 > /tmp/koadr-web-<tag>.tar.gz
scp -C /tmp/koadr-web-<tag>.tar.gz adapedu-vps:/tmp/
ssh adapedu-vps 'gunzip -c /tmp/koadr-web-<tag>.tar.gz | docker load'
```

The tarball is ~650 MB. Check free disk on the host first (`df -h /`); see §5.

## 4. Deploy and verify

Record the running tag, switch the pin, recreate:

```bash
ssh adapedu-vps 'docker inspect koadr-web --format "{{.Config.Image}}"'   # rollback target
ssh adapedu-vps 'cd /opt/koadr && cp docker-compose.yml docker-compose.yml.bak-<tag> \
  && sed -i "s|koadr-web:<old>|koadr-web:<tag>|" docker-compose.yml \
  && docker compose -p koadr up -d'
```

Verify through the public edge, not just localhost — a healthy container behind a
broken Caddy still looks fine from inside:

```bash
curl -s -o /dev/null -w "root: %{http_code}\n" https://app.koadr.dev/   # 302 → /login
curl -s -o /dev/null -w "login: %{http_code} %{size_download}B\n" https://app.koadr.dev/login
```

`302` on `/` is the auth guard working, not a failure. A `200` with a tiny body is.

To prove the *right* build is live, fetch the asset the page references and grep for a
string from the change:

```bash
A=$(curl -s https://app.koadr.dev/login | grep -o '/assets/Chat.client-[^"]*\.js' | head -1)
curl -s "https://app.koadr.dev$A" | grep -c "<a string from the change>"   # expect ≥ 1
```

## 5. Clean up

```bash
rm -f /tmp/koadr-web-<tag>.tar.gz
ssh adapedu-vps 'rm -f /tmp/koadr-web-<tag>.tar.gz'
ssh adapedu-vps 'docker images --format "{{.Repository}}:{{.Tag}} {{.CreatedAt}}" | grep koadr-web'
```

Every loaded image is kept by default and each is ~4.7 GB. Remove the ones you will not
roll back to, keeping the running tag and at least one previous release:

```bash
ssh adapedu-vps 'docker rmi koadr-web:<tag-to-drop>'
```

`docker image prune` does not help — it only removes dangling (untagged) images, and
these are all tagged.

## Theme changes

Koadr ships **one brand design** with a light and a dark mode — there is no palette
picker. When touching anything visual:

- `app/styles/variables.scss` holds only `:root` (light) and `:root[data-theme='dark']`.
  Do not reintroduce `data-color-theme` blocks; the palette system and its 28 themes were
  removed deliberately.
- Accent backgrounds come from `theme('colors.accent.500')` (`#FF6600`). The
  accent-intensity slider shifts between `accent.600` and `accent.500`; it must never mix
  toward `transparent`, which used to drop white-on-accent CTAs below WCAG AA.
- White on `#FF6600` is only 2.9:1. Use the near-black ink `#1A1A1A` for text on accent
  (5.4–6.1:1).
- `purple-*` utilities are aliased to the orange ramp in `uno.config.ts`. Raw hex
  (`#8b5cf6`) is **not** aliased — always use the token or `accent-*`.

Persisted values are migrated, never rejected: `normaliseTheme()` maps any legacy id
(`dark-dracula`, `light-solarized`, …) onto its light/dark mode. It runs on load, in the
pre-hydration script, in `resolveSettings`, and in `POST /api/settings` — keep those four
in sync if the model changes again.

## Rollback

```bash
ssh adapedu-vps 'cd /opt/koadr && cp docker-compose.yml.bak-<tag> docker-compose.yml \
  && docker compose -p koadr up -d'
```
