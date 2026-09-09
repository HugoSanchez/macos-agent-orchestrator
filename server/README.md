# Hosted services

- `frontend/` is the Next.js website, including `/privacy`, `/llms.txt`, and the
  Sparkle update feed at `/appcast.xml`.
- `backend/` is the managed API for accounts, connected apps, and usage events.

The Mac app and its memory engine live in `../desktop/`. The shared Composio
integration lives in `../packages/composio/`. Keep the full repository checkout
available when installing backend dependencies.

## Development

Run these commands from the repository root in separate terminals:

```sh
cd server/frontend
npm ci
npm run dev
```

```sh
cd server/backend
npm ci
npm run dev
```

Each service has a `.env.example` next to its `package.json`. Existing local
`.env` files belong in those same service directories. The website and backend
have separate deployments; neither is required to build the desktop in local mode.

## Deployment

Hosting settings are managed outside this repository. When deploying the move
from the former root-level `frontend/` and `backend/` directories, update the
existing projects to these paths:

| Setting | Website (Vercel) | Backend (Render) |
| --- | --- | --- |
| Root Directory | `server/frontend` | Repository root (leave blank) |
| Install/build command | `npm ci` / `npm run build` | `cd server/backend && npm ci` |
| Start command | Next.js framework default | `cd server/backend && npm run serve` |

The backend needs repository-root access because its dependency
`../../packages/composio` is outside `server/backend`. If build filters are
configured, include both `server/backend/**` and `packages/composio/**`.
Update any custom migration command to run from `server/backend` as well.

Coordinate these settings with the first deployment of the new layout. An older
commit has the old paths, so a rollback also needs matching directory settings.
Preserve existing environment variables, domains, database configuration, and
service identities. Moving these directories does not require a database
migration or a new desktop release.

Provider references: [Vercel monorepos](https://vercel.com/docs/monorepos) and
[Render root directories](https://render.com/docs/monorepo-support#setting-a-root-directory).
